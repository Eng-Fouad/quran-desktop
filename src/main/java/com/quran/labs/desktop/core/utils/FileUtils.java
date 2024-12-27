package com.quran.labs.desktop.core.utils;

import com.quran.labs.desktop.core.errors.LabelAndCode;
import com.quran.labs.desktop.core.errors.UtilityException;
import io.quarkus.logging.Log;
import jakarta.ws.rs.core.HttpHeaders;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.channels.ReadableByteChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.Comparator;
import java.util.Locale;
import java.util.function.Consumer;
import java.util.zip.ZipFile;

/// Utility class for dealing with files.
///
/// @author Fouad Almalki
public class FileUtils {

    /**
     * File errors.
     *
     * @author Fouad Almalki
     */
    public enum FileError implements LabelAndCode {
        FAILED_TO_DELETE_PATH("QD-C0010"),
        FAILED_TO_DELETE_DIRECTORY_RECURSIVELY("QD-C0011"),
        FAILED_TO_CREATE_DIRECTORY("QD-C0012"),
        FAILED_TO_DOWNLOAD_FILE("QD-C0013"),
        ZIP_FILE_HAS_ZIP_SLIP("QD-C0014"),
        FAILED_TO_DECOMPRESS_ZIP_FILE("QD-C0015"),

        ;

        private final String code;

        FileError(String code) {
            this.code = code;
        }

        @Override
        public String label(){return name();}

        @Override
        public String code(){return code;}
    }

    public record DownloadingProgress(boolean completed, int soFar, Integer total){}

    private static class TrackableReadableByteChannel implements ReadableByteChannel {

        private final ReadableByteChannel channel;
        private final Consumer<DownloadingProgress> progressListener;
        private final Integer totalBytes;
        private int soFarBytes;

        public TrackableReadableByteChannel(ReadableByteChannel channel, Consumer<DownloadingProgress> progressListener,
                                            Integer totalBytes) {
            this.channel = channel;
            this.progressListener = progressListener;
            this.totalBytes = totalBytes;
        }

        @Override
        public int read(ByteBuffer dst) throws IOException {
            int bytesRead = channel.read(dst);
            if (bytesRead > 0) {
                soFarBytes += bytesRead;
                progressListener.accept(new DownloadingProgress(false, soFarBytes, totalBytes));
            } else if (bytesRead < 0) {
                if (totalBytes != null) {
                    progressListener.accept(new DownloadingProgress(true, totalBytes, totalBytes));
                } else {
                    progressListener.accept(new DownloadingProgress(true, soFarBytes, soFarBytes));
                }
            }
            return bytesRead;
        }

        @Override
        public boolean isOpen() {
            return channel.isOpen();
        }

        @Override
        public void close() throws IOException {
            channel.close();
        }
    }

    private static final HttpClient HTTP_CLIENT = HttpClient.newHttpClient();

    public static void deleteDirectoryRecursively(Path dirPath) {
        try (var pathStream = Files.walk(dirPath)) {
            pathStream.sorted(Comparator.reverseOrder()).forEach(FileUtils::deletePath);
        } catch (Throwable t) {
            Log.error(String.format(Locale.ENGLISH, "Failed to delete directory recursively (%s)", dirPath), t);
            throw new UtilityException(t, FileError.FAILED_TO_DELETE_DIRECTORY_RECURSIVELY);
        }
    }

    public static void downloadFile(String url, Path filePath, Consumer<DownloadingProgress> progressListener) {
        Integer totalBytes = null;
        var uri = URI.create(url);

        // get total size from server
        try {
            HttpResponse<Void> httpResponse = HTTP_CLIENT.send(HttpRequest.newBuilder().uri(uri).HEAD().build(),
                                                               HttpResponse.BodyHandlers.discarding());
            long contentLength = httpResponse.headers().firstValueAsLong(HttpHeaders.CONTENT_LENGTH).orElse(-1L);
            if (contentLength > 0) {
                totalBytes = Math.toIntExact(contentLength);
            }
        } catch (Throwable t) {
            Log.warn(String.format(Locale.ENGLISH, "Failed to retrieve file size from server (%s)", url), t);
        }

        // make sure the directory and its parent directories are created
        var parentDirPath = filePath.getParent();
        createDirectory(parentDirPath);

        // start streaming file from server to local file
        try (var targetChannel = FileChannel.open(filePath);
             var sourceChannel = new TrackableReadableByteChannel(
                                        Channels.newChannel(uri.toURL().openStream()), progressListener, totalBytes)) {
            targetChannel.transferFrom(sourceChannel, 0, Long.MAX_VALUE);
        } catch (Throwable t) {
            Log.error(String.format(Locale.ENGLISH, "Failed to download the file (url = %s) (filePath = %s)",
                                    url, filePath), t);
            throw new UtilityException(t, FileError.FAILED_TO_DOWNLOAD_FILE);
        }
    }

    public static void decompressZipFile(Path zipFilePath, Path destDirPath) {
        try (var zipFile = new ZipFile(zipFilePath.toFile())) {
            for (var zipEntry : Collections.list(zipFile.entries())) {
                var destSubPath = Path.of(destDirPath.toString(), zipEntry.getName()).normalize();
                if (!destSubPath.startsWith(destDirPath)) {
                    Log.error(String.format(Locale.ENGLISH, "Zip file has a zip slip record " +
                                            "(zipFilePath = %s) (destDirPath = %s) (destSubPath = %s)",
                                            zipFilePath, destDirPath, destSubPath));
                    throw new UtilityException(FileError.ZIP_FILE_HAS_ZIP_SLIP);
                }
                if (zipEntry.isDirectory()) {
                    createDirectory(destSubPath);
                } else {
                    // make sure the directory and its parent directories are created
                    var parentDirPath = destDirPath.getParent();
                    createDirectory(parentDirPath);

                    try (var targetChannel = FileChannel.open(destDirPath);
                         var sourceChannel = Channels.newChannel(zipFile.getInputStream(zipEntry))) {
                        targetChannel.transferFrom(sourceChannel, 0, Long.MAX_VALUE);
                    }
                }
            }
        } catch (Throwable t) {
            Log.error(String.format(Locale.ENGLISH,
                      "Failed to decompress the zip file (zipFilePath = %s) (destDirPath = %s)",
                      zipFilePath, destDirPath), t);
            throw new UtilityException(t, FileError.FAILED_TO_DECOMPRESS_ZIP_FILE);
        }
    }

    private static void deletePath(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (Throwable t) {
            Log.error(String.format(Locale.ENGLISH, "Failed to delete the path (%s)", path), t);
            throw new UtilityException(t, FileError.FAILED_TO_DELETE_PATH);
        }
    }

    private static void createDirectory(Path path) {
        try {
            Files.createDirectories(path);
        } catch (Throwable t) {
            Log.error(String.format(Locale.ENGLISH, "Failed to create the directory (%s)", path), t);
            throw new UtilityException(t, FileError.FAILED_TO_CREATE_DIRECTORY);
        }
    }
}
package com.quran.labs.desktop.db;

import io.agroal.api.AgroalDataSource;
import io.agroal.api.configuration.supplier.AgroalPropertiesReader;
import jakarta.enterprise.context.ApplicationScoped;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.core.extension.ExtensionCallback;
import org.jdbi.v3.core.extension.ExtensionConsumer;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;

import java.nio.file.Path;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.Map;

@ApplicationScoped
public class QuranDatabase {

    private Jdbi jdbi;

    public void initDatabase(Path dbFilePath) throws SQLException {
        Map<String,String> props = new HashMap<>();
        props.put(AgroalPropertiesReader.MAX_SIZE, "10");
        props.put(AgroalPropertiesReader.MIN_SIZE, "10");
        props.put(AgroalPropertiesReader.INITIAL_SIZE, "10");
        props.put(AgroalPropertiesReader.MAX_LIFETIME_S, "300");
        props.put(AgroalPropertiesReader.ACQUISITION_TIMEOUT_S, "30");
        props.put(AgroalPropertiesReader.JDBC_URL, "jdbc:sqlite:%s".formatted(dbFilePath.toAbsolutePath().toString()));
        var datasource = AgroalDataSource.from(new AgroalPropertiesReader().readProperties(props).get());
        jdbi = Jdbi.create(datasource).installPlugin(new SqlObjectPlugin());
    }

    public <X extends Exception> void useJdbi(ExtensionConsumer<QuranDao, X> callback) throws X {
        jdbi.useExtension(QuranDao.class, callback);
    }

    public <R, X extends Exception> R withJdbi(ExtensionCallback<R, QuranDao, X> callback) throws X {
        return jdbi.withExtension(QuranDao.class, callback);
    }

    public interface QuranDao {

    }
}
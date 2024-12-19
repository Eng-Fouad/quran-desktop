package com.quran.labs.desktop.db;

import io.agroal.api.AgroalDataSource;
import io.agroal.api.configuration.supplier.AgroalPropertiesReader;
import jakarta.enterprise.context.ApplicationScoped;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.core.extension.ExtensionCallback;
import org.jdbi.v3.core.extension.ExtensionConsumer;
import org.jdbi.v3.core.transaction.TransactionIsolationLevel;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.jdbi.v3.sqlobject.config.RegisterRowMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.transaction.Transaction;

import java.nio.file.Path;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

@ApplicationScoped
public class AyahInfoDatabase {

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

    public <X extends Exception> void useJdbi(ExtensionConsumer<AyahInfoDao, X> callback) throws X {
        jdbi.useExtension(AyahInfoDao.class, callback);
    }

    public <R, X extends Exception> R withJdbi(ExtensionCallback<R, AyahInfoDao, X> callback) throws X {
        return jdbi.withExtension(AyahInfoDao.class, callback);
    }

    public interface AyahInfoDao {
        @SqlQuery("""
        SELECT page_number
        FROM glyphs
        WHERE glyph_id = :id
        """)
        int getTest(@Bind("id") int id);
    }
}
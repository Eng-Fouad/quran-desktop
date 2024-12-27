package com.quran.labs.desktop.core.errors;

import java.util.Map;

/**
 * Exception that is thrown to indicate an error in a utility class.
 *
 * @author Fouad Almalki
 */
public class UtilityException extends DetailedRuntimeException {

    public UtilityException(String logMessage, Throwable cause, LabelAndCode labelAndCode) {
        super(logMessage, cause, labelAndCode);
    }

    public UtilityException(Throwable cause, LabelAndCode labelAndCode) {
        super(cause, labelAndCode);
    }

    public UtilityException(String logMessage, LabelAndCode labelAndCode) {
        super(logMessage, labelAndCode);
    }

    public UtilityException(LabelAndCode labelAndCode) {
        super(labelAndCode);
    }

    public UtilityException(String logMessage, LabelAndCode labelAndCode,
                             Map<String, Object> moreDetails) {
        super(logMessage, labelAndCode, moreDetails);
    }

    public UtilityException(LabelAndCode labelAndCode, Map<String, Object> moreDetails) {
        super(labelAndCode, moreDetails);
    }
}
package com.quran.labs.desktop.core.errors;

import jakarta.ws.rs.WebApplicationException;

import java.util.Map;

/**
 * Base exception class that holds error code and optional map of more details.
 * 
 * @author Fouad Almalki
 */
public abstract class DetailedRuntimeException extends WebApplicationException {
    
    private final LabelAndCode labelAndCode;
    private Map<String, Object> moreDetails;
    
    public DetailedRuntimeException(String logMessage, Throwable cause, LabelAndCode labelAndCode) {
        super(logMessage, cause);
        this.labelAndCode = labelAndCode;
    }
    
    public DetailedRuntimeException(String logMessage, LabelAndCode labelAndCode) {
        this(logMessage, null, labelAndCode);
    }
    
    public DetailedRuntimeException(LabelAndCode labelAndCode) {
        this("%s (%s)".formatted(labelAndCode.label(), labelAndCode.code()), null, labelAndCode);
    }
    
    public DetailedRuntimeException(Throwable cause, LabelAndCode labelAndCode) {
        this("%s (%s)".formatted(labelAndCode.label(), labelAndCode.code()), cause, labelAndCode);
    }
    
    public DetailedRuntimeException(String logMessage, Throwable cause, LabelAndCode labelAndCode,
                                    Map<String, Object> moreDetails) {
        super(logMessage, cause);
        this.labelAndCode = labelAndCode;
        this.moreDetails = moreDetails;
    }
    
    public DetailedRuntimeException(String logMessage, LabelAndCode labelAndCode,
                                    Map<String, Object> moreDetails) {
        this(logMessage, null, labelAndCode, moreDetails);
    }
    
    public DetailedRuntimeException(LabelAndCode labelAndCode, Map<String, Object> moreDetails) {
        this("%s (%s) [moreDetails: %s]".formatted(labelAndCode.label(), labelAndCode.code(), moreDetails), null,
             labelAndCode, moreDetails);
    }
    
    public LabelAndCode labelAndCode(){return labelAndCode;}
    public Map<String, Object> moreDetails(){return moreDetails;}
}
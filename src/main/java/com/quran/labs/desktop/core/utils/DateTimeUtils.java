package com.quran.labs.desktop.core.utils;

import com.quran.labs.desktop.core.enums.GuiLanguage;

import java.text.MessageFormat;
import java.time.Duration;
import java.time.Instant;
import java.time.Period;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.function.Function;

/**
 * Utility class for dealing with dates and times.
 *
 * @author Fouad Almalki
 */
public class DateTimeUtils {

    private static final DateTimeFormatter ARABIC_TIME_FORMATTER = DateTimeFormatter.ofPattern("h:mm a").localizedBy(AppConstants.Locales.SAUDI_AR_LOCALE);
    private static final DateTimeFormatter ENGLISH_TIME_FORMATTER = DateTimeFormatter.ofPattern("h:mm a").localizedBy(AppConstants.Locales.SAUDI_EN_LOCALE);
    private static final DateTimeFormatter ARABIC_WEEK_DAY_FORMATTER = DateTimeFormatter.ofPattern("EEEE").localizedBy(AppConstants.Locales.SAUDI_AR_LOCALE);
    private static final DateTimeFormatter ENGLISH_WEEK_DAY_FORMATTER = DateTimeFormatter.ofPattern("EEEE").localizedBy(AppConstants.Locales.SAUDI_EN_LOCALE);
    private static final DateTimeFormatter ARABIC_SHORT_DATE_FORMATTER = DateTimeFormatter.ofPattern("dd MMM").localizedBy(AppConstants.Locales.SAUDI_AR_LOCALE);
    private static final DateTimeFormatter ENGLISH_SHORT_DATE_FORMATTER = DateTimeFormatter.ofPattern("dd MMM").localizedBy(AppConstants.Locales.SAUDI_EN_LOCALE);
    private static final DateTimeFormatter ARABIC_FULL_DATE_FORMATTER = DateTimeFormatter.ofPattern("dd MMM yyyy").localizedBy(AppConstants.Locales.SAUDI_AR_LOCALE);
    private static final DateTimeFormatter ENGLISH_FULL_DATE_FORMATTER = DateTimeFormatter.ofPattern("dd MMM yyyy").localizedBy(AppConstants.Locales.SAUDI_EN_LOCALE);

    public static String calculateElapsedTime(Instant targetInstant, Function<String, String> localizationFunction, GuiLanguage guiLanguage) {
        var nowInstant = Instant.now();
        var duration = Duration.between(targetInstant, nowInstant);
        long seconds = duration.getSeconds();
        long minutes = duration.toMinutes();
        long hours = duration.toHours();
        long days = duration.toDays();
        if (duration.isNegative() || seconds < 60) {
            return localizationFunction.apply("label.momentsAgo");
        } else if (minutes == 1) {
            return localizationFunction.apply("label.oneMinuteAgo");
        } else if (minutes == 2) {
            return localizationFunction.apply("label.twoMinutesAgo");
        } else if (minutes >= 3 && minutes <= 10) {
            return MessageFormat.format(localizationFunction.apply("label.threeToTenMinutesAgo"), minutes);
        } else if (minutes < 60) {
            return MessageFormat.format(localizationFunction.apply("label.moreThanTenMinutesAgo"), minutes);
        } else {
            var targetZonedDateTime = ZonedDateTime.ofInstant(targetInstant, AppConstants.SAUDI_TIMEZONE);
            if (hours < 24) {
                return targetZonedDateTime.format(guiLanguage == GuiLanguage.ARABIC ?
                                                  ARABIC_TIME_FORMATTER : ENGLISH_TIME_FORMATTER);
            }
            else if (days < 7) {
                return targetZonedDateTime.format(guiLanguage == GuiLanguage.ARABIC ?
                                                  ARABIC_WEEK_DAY_FORMATTER : ENGLISH_WEEK_DAY_FORMATTER);
            } else {
                var nowZonedDateTime = ZonedDateTime.ofInstant(nowInstant, AppConstants.SAUDI_TIMEZONE);
                var period = Period.between(targetZonedDateTime.toLocalDate(), nowZonedDateTime.toLocalDate());
                int years = period.getYears();
                if (years < 1) {
                    return targetZonedDateTime.format(guiLanguage == GuiLanguage.ARABIC ?
                                                      ARABIC_SHORT_DATE_FORMATTER : ENGLISH_SHORT_DATE_FORMATTER);
                } else {
                    return targetZonedDateTime.format(guiLanguage == GuiLanguage.ARABIC ?
                                                      ARABIC_FULL_DATE_FORMATTER : ENGLISH_FULL_DATE_FORMATTER);
                }
            }
        }
    }
}
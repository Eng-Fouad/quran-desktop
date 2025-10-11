package com.quran.labs.desktop.core.configs;

import io.quarkus.runtime.annotations.RegisterForReflection;
import io.quarkus.runtime.annotations.RegisterResourceBundle;
import io.quarkus.runtime.annotations.RegisterResources;

@RegisterResourceBundle(bundleName = "i18n.strings")
@RegisterResources(globs = {"views/**", "styles/**", "images/**", "META-INF/resources/ikonli/0.0.0/fonts/ikonli.ttf", "META-INF/resources/carbonicons/10.23.2/fonts/Carbon-Icons.ttf", "META-INF/services/org.kordamp.ikonli.IkonHandler", "org/controlsfx/control/segmentedbutton.css"})
@RegisterForReflection(classNames = {"org.kordamp.ikonli.IkonliIkonResolver", "org.kordamp.ikonli.carbonicons.CarboniconsIkonHandler", "org.kordamp.ikonli.javafx.FontIcon", "org.controlsfx.control.SegmentedButton"})
public class NativeConfigs {}

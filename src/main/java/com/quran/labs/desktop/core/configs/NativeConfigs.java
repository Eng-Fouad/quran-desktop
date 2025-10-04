package com.quran.labs.desktop.core.configs;

import io.quarkus.runtime.annotations.RegisterResourceBundle;
import io.quarkus.runtime.annotations.RegisterResources;

@RegisterResourceBundle(bundleName = "i18n.strings")
@RegisterResources(globs = {"/views/**", "/styles/**", "/images/**"})
public class NativeConfigs {}

package dk.pladetjek.app;

import java.util.Locale;
import java.util.regex.Pattern;

final class PlateFormat {
    private static final Pattern DANISH_REGISTRATION =
            Pattern.compile("^[A-ZÆØÅ]{2}[0-9]{5}$");

    private PlateFormat() {
    }

    static String normalize(String value) {
        if (value == null) return "";
        return value
                .toUpperCase(Locale.ROOT)
                .replaceAll("[^A-ZÆØÅ0-9]", "");
    }

    static boolean isDanishRegistration(String value) {
        return DANISH_REGISTRATION.matcher(normalize(value)).matches();
    }
}

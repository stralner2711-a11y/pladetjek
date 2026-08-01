package dk.pladetjek.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PlateFormatUnitTest {
    @Test
    public void normalizesCommonCameraSeparators() {
        assertEquals("AB12345", PlateFormat.normalize(" ab-12 345 "));
    }

    @Test
    public void acceptsDanishRegistrationFormat() {
        assertTrue(PlateFormat.isDanishRegistration("øa 12 345"));
    }

    @Test
    public void rejectsArbitraryCameraText() {
        assertFalse(PlateFormat.isDanishRegistration("POLITI"));
        assertFalse(PlateFormat.isDanishRegistration("123456789"));
    }
}

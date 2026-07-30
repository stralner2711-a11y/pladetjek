package dk.pladetjek.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

@CapacitorPlugin(name = "PlateTextRecognizer")
public class PlateTextRecognizerPlugin extends Plugin {
    private static final int MAX_BASE64_LENGTH = 6_000_000;
    private final TextRecognizer recognizer =
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

    @PluginMethod
    public void recognize(PluginCall call) {
        String encoded = call.getString("imageBase64", "");
        if (encoded.isEmpty() || encoded.length() > MAX_BASE64_LENGTH) {
            call.reject("Kamerabilledet er tomt eller for stort.");
            return;
        }

        try {
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null) {
                call.reject("Kamerabilledet kunne ikke læses.");
                return;
            }

            InputImage image = InputImage.fromBitmap(bitmap, 0);
            recognizer.process(image)
                .addOnSuccessListener(result -> {
                    JSObject payload = new JSObject();
                    payload.put("text", result.getText());
                    payload.put("imageWidth", bitmap.getWidth());
                    payload.put("imageHeight", bitmap.getHeight());

                    JSArray lines = new JSArray();
                    for (Text.TextBlock block : result.getTextBlocks()) {
                        for (Text.Line line : block.getLines()) {
                            Rect lineBounds = line.getBoundingBox();
                            if (lineBounds == null) continue;

                            JSObject linePayload = geometryPayload(
                                line.getText(),
                                line.getConfidence(),
                                lineBounds
                            );
                            linePayload.put("angle", line.getAngle());

                            JSArray elements = new JSArray();
                            for (Text.Element element : line.getElements()) {
                                Rect elementBounds = element.getBoundingBox();
                                if (elementBounds == null) continue;
                                elements.put(geometryPayload(
                                    element.getText(),
                                    element.getConfidence(),
                                    elementBounds
                                ));
                            }
                            linePayload.put("elements", elements);
                            lines.put(linePayload);
                        }
                    }
                    payload.put("lines", lines);
                    call.resolve(payload);
                    bitmap.recycle();
                })
                .addOnFailureListener(error -> {
                    bitmap.recycle();
                    call.reject("Tekstgenkendelsen mislykkedes: " + error.getMessage(), error);
                });
        } catch (Exception error) {
            call.reject("Kamerabilledet kunne ikke behandles.", error);
        }
    }

    private JSObject geometryPayload(String text, float confidence, Rect bounds) {
        JSObject payload = new JSObject();
        payload.put("text", text);
        payload.put("confidence", confidence);
        payload.put("left", bounds.left);
        payload.put("top", bounds.top);
        payload.put("width", bounds.width());
        payload.put("height", bounds.height());
        return payload;
    }
}

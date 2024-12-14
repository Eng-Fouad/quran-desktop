package com.quran.labs.desktop.core.ui;

import com.quran.labs.desktop.core.errors.LabelAndCode;
import com.quran.labs.desktop.home.dto.ChatType;
import com.quran.labs.desktop.home.dto.MessageDeliveryStatus;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import javafx.animation.Animation;
import javafx.animation.Interpolator;
import javafx.animation.RotateTransition;
import javafx.geometry.NodeOrientation;
import javafx.scene.Group;
import javafx.scene.Node;
import javafx.scene.Scene;
import javafx.scene.control.Alert;
import javafx.scene.control.ButtonBar;
import javafx.scene.layout.StackPane;
import javafx.scene.paint.Color;
import javafx.scene.shape.Circle;
import javafx.scene.shape.Rectangle;
import javafx.scene.shape.SVGPath;
import javafx.scene.text.Font;
import javafx.scene.text.FontWeight;
import javafx.scene.text.Text;
import javafx.scene.text.TextAlignment;
import javafx.scene.text.TextBoundsType;
import javafx.util.Duration;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Arrays;

/**
 * A factory class for creating various GUI components.
 *
 * @author Fouad Almalki
 */
@ApplicationScoped
public final class GuiFactory {

    public record ButtonInfo(String labelKey, ButtonBar.ButtonData buttonData){}

    private static final String SVG_INDIVIDUAL_AVATAR = "M50,41h-0.06a18,18 0,1 0,-19.88 0H30A23,23 0,0 0,7 64v1H8.5V64A21.52,21.52 0,0 1,30 42.5h2.82a17.93,17.93 0,0 0,14.36 0H50A21.52,21.52 0,0 1,71.5 64v1H73V64A23,23 0,0 0,50 41ZM40,42.5A16.5,16.5 0,1 1,56.5 26,16.5 16.5,0 0,1 40,42.5Z";
    private static final String SVG_GROUP_AVATAR = "M60.54,30.58a13,13 0,1 0,-15.08 0,15.81 15.81,0 0,0 -7.38,2.64A13,13 0,1 0,19.46 50.58,16 16,0 0,0 5,66.5L5,68L6.5,68L6.5,66.5A14.51,14.51 0,0 1,21 52h1a13,13 0,0 0,10 0h1A14.51,14.51 0,0 1,47.5 66.5L47.5,68L49,68L49,66.5A16,16 0,0 0,34.54 50.58a12.94,12.94 0,0 0,4.25 -16A14.45,14.45 0,0 1,47 32h1a13,13 0,0 0,10 0h1A14.51,14.51 0,0 1,73.5 46.5L73.5,48L75,48L75,46.5A16,16 0,0 0,60.54 30.58ZM27,51.5A11.5,11.5 0,1 1,38.5 40,11.5 11.5,0 0,1 27,51.5ZM53,31.5A11.5,11.5 0,1 1,64.5 20,11.5 11.5,0 0,1 53,31.5Z";
    private static final String SVG_SENDING_ICON = "m11.5 0h1v1h-1zm0 11h1v1h-1zm-5.5-5.5h1v1h-1zm11 0h1v1h-1zm-.0538476-2.9330127.5.8660254-.8660254.5-.5-.8660254zm-9.52627942 5.5.5.8660254-.8660254.5-.5-.8660254zm2.01313972-7.51313972.5.8660254-.8660254.5-.5-.8660254zm5.5 9.52627942.5.8660254-.8660254.5-.5-.8660254zm-.3660254-9.52627942.8660254.5-.5.8660254-.8660254-.5zm-5.5 9.52627942.8660254.5-.5.8660254-.8660254-.5zm-2.01313972-7.5131397.8660254.5-.5.8660254-.8660254-.5zm9.52627942 5.5.8660254.5-.5.8660254-.8660254-.5z";
    private static final String SVG_SENT_ICON = "m12 0c3.312 0 6 2.688 6 6s-2.688 6-6 6-6-2.688-6-6 2.688-6 6-6zm0 1c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm-1 7.5-2.5-2.5.705-.705 1.795 1.79 3.795-3.795.705.71z";
    private static final String SVG_DELIVERED_ICON = "m7.91731278.31325719c-.32790187.23582695-.63457732.4993134-.91661079.7870438-.32335648-.06576997-.65802117-.10030099-1.00070199-.10030099-2.76 0-5 2.24-5 5s2.24 5 5 5c.34268082 0 .67734551-.034531 1.00070199-.100301.28203347.2877304.58870892.5512169.91661079.7870438-.60212935.203133-1.24693879.3132572-1.91731278.3132572-3.312 0-6-2.688-6-6s2.688-6 6-6c.67037399 0 1.31518343.11012424 1.91731278.31325719zm-2.84464825 6.69907828c.05711006.39424873.14707821.77785835.2670378 1.1479622l-.33970233.33970233-2.5-2.5.705-.705 1.795 1.79zm6.92733547-7.01233547c3.312 0 6 2.688 6 6s-2.688 6-6 6-6-2.688-6-6 2.688-6 6-6zm0 1c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm-1 7.5-2.5-2.5.705-.705 1.795 1.79 3.795-3.795.705.71z";
    private static final String SVG_READ_ICON = "m7.91731278.31325719c-1.76677902 1.27066705-2.91731278 3.34434415-2.91731278 5.68674281 0 .343797.0247846.68180525.07266453 1.01233547l-.07266453.07266453-1.795-1.79-.705.705 2.5 2.5.33970233-.33970233c.46469584 1.43369719 1.3794459 2.66472543 2.57761045 3.52644513-.60212935.203133-1.24693879.3132572-1.91731278.3132572-3.312 0-6-2.688-6-6s2.688-6 6-6c.67037399 0 1.31518343.11012424 1.91731278.31325719zm4.08268722-.31325719c3.312 0 6 2.688 6 6s-2.688 6-6 6-6-2.688-6-6 2.688-6 6-6zm-1 8.5 4.5-4.5-.705-.71-3.795 3.795-1.795-1.79-.705.705z";
    private static final String SVG_MUTED_CHAT_ICON = "M3.993 7.01c.002-.07.006-.139.01-.208l1.38 1.38c-.21 2.44-.795 3.652-1.454 4.43a5.909 5.909 0 0 1-.581.59 3.98 3.98 0 0 0-.256.248c-.117.129-.175.225-.175.468a.55.55 0 0 0 .537.561h8.226l1.811 1.81c-.447 1.507-1.814 2.565-3.49 2.565-1.806 0-3.252-1.226-3.578-2.916H3.454c-1.114 0-1.996-.917-1.996-2.02 0-.658.231-1.093.555-1.45.115-.125.248-.248.36-.351l.062-.058c.133-.124.258-.245.381-.39.46-.543 1.07-1.628 1.177-4.658Zm3.934 8.927c.286.869 1.081 1.459 2.073 1.459s1.787-.59 2.073-1.459H7.927Zm9.156-2.019a.573.573 0 0 1-.076.29l1.04 1.04a2.03 2.03 0 0 0 .495-1.33c0-.658-.231-1.093-.555-1.45a5.869 5.869 0 0 0-.36-.351l-.062-.058a4.495 4.495 0 0 1-.381-.39c-.46-.543-1.07-1.628-1.177-4.658-.119-3.417-2.823-5.865-6.007-5.865a5.99 5.99 0 0 0-4.28 1.776l1.032 1.03A4.532 4.532 0 0 1 10 2.605c2.414 0 4.459 1.841 4.55 4.458.112 3.206.769 4.661 1.521 5.55.18.211.355.379.5.515l.082.075c.11.103.187.173.255.248.117.129.175.225.175.468ZM2.599 1.568a.73.73 0 0 0-1.031 1.03L17.4 18.433a.73.73 0 1 0 1.031-1.031L2.6 1.568Z";

    private static final Color[] COLORS_PALETTE = {
        Color.BLUE, Color.BLUEVIOLET, Color.CHOCOLATE, Color.CRIMSON, Color.INDIGO, Color.LIGHTCORAL, Color.LIGHTSALMON,
        Color.LIGHTSEAGREEN, Color.LIGHTSKYBLUE, Color.LIGHTSLATEGRAY, Color.LIGHTSTEELBLUE, Color.LIMEGREEN,
        Color.MAROON, Color.MEDIUMBLUE, Color.MEDIUMORCHID, Color.MEDIUMPURPLE, Color.MEDIUMSEAGREEN,
        Color.MEDIUMSLATEBLUE, Color.MEDIUMTURQUOISE, Color.MEDIUMVIOLETRED, Color.MIDNIGHTBLUE, Color.OLIVE,
        Color.OLIVEDRAB, Color.ORANGE, Color.ORANGERED, Color.ORCHID, Color.PALEGOLDENROD, Color.PALEVIOLETRED,
        Color.PERU, Color.PLUM, Color.POWDERBLUE, Color.PURPLE, Color.RED, Color.ROSYBROWN, Color.ROYALBLUE,
        Color.SALMON, Color.SANDYBROWN, Color.SEAGREEN, Color.SIENNA, Color.SKYBLUE, Color.SLATEBLUE, Color.STEELBLUE,
        Color.TAN, Color.TEAL, Color.THISTLE, Color.TOMATO, Color.TURQUOISE, Color.VIOLET, Color.YELLOWGREEN
    };
    private static final Color COLOR_UNKNOWN = Color.SLATEGRAY;
    private static final Color COLOR_DELIVERY_STATUS_ICON = Color.web("858585FF");
    private static final Color COLOR_MUTED_CHAT_ICON = Color.web("3C3C3C");
    private static final Color COLOR_ROUNDED_NUMBER = Color.web("2E6CED");

    @Inject MessageDialogFxController alertDialogFxController;
    @Inject HttpErrorDialogFxController httpErrorDialogFxController;
    @Inject StacktraceDialogFxController stacktraceDialogFxController;

    public Node generateMutedChatIcon() {
        var svgPath = new SVGPath();
        svgPath.setFill(COLOR_MUTED_CHAT_ICON);
        svgPath.setContent(SVG_MUTED_CHAT_ICON);
        svgPath.setNodeOrientation(NodeOrientation.LEFT_TO_RIGHT);
        svgPath.setScaleX(0.7);
        svgPath.setScaleY(0.7);
        return svgPath;
    }

    public Node generateMessageDeliveryStatusIcon(MessageDeliveryStatus messageDeliveryStatus) {
        var group = new Group();
        var svgPath = new SVGPath();
        svgPath.setFill(COLOR_DELIVERY_STATUS_ICON);
        switch (messageDeliveryStatus) {
            case SENDING -> {
                svgPath.setContent(SVG_SENDING_ICON);
                var rotator = new RotateTransition(Duration.seconds(3), group);
                rotator.setFromAngle(360);
                rotator.setToAngle(0);
                rotator.setInterpolator(Interpolator.LINEAR);
                rotator.setCycleCount(Animation.INDEFINITE);
                rotator.play();
            }
            case SENT -> svgPath.setContent(SVG_SENT_ICON);
            case DELIVERED -> {
                svgPath.setContent(SVG_DELIVERED_ICON);
            }
            case READ -> svgPath.setContent(SVG_READ_ICON);
        }
        svgPath.setNodeOrientation(NodeOrientation.LEFT_TO_RIGHT);
        group.getChildren().add(svgPath);
        return group;
    }

    public Node generateAvatarNode(ChatType chatType, String forTitle, double radiusInPixels) {
        var stackPane = new StackPane();

        var imageCircle = new Circle(radiusInPixels * 2, radiusInPixels * 2, radiusInPixels);
        imageCircle.setFill(selectColorForTitle(forTitle));
        stackPane.getChildren().add(imageCircle);

        var svgPath = new SVGPath();
        svgPath.setFill(Color.WHITE);
        svgPath.setContent(switch (chatType) {
            case INDIVIDUAL -> SVG_INDIVIDUAL_AVATAR;
            case GROUP -> SVG_GROUP_AVATAR;
        });
        svgPath.setNodeOrientation(NodeOrientation.LEFT_TO_RIGHT);
        stackPane.getChildren().add(svgPath);

        var bounds = svgPath.getBoundsInParent();
        double scale = Math.min(radiusInPixels / bounds.getWidth(), radiusInPixels / bounds.getHeight());
        svgPath.setScaleX(scale);
        svgPath.setScaleY(scale);

        return stackPane;
    }

    public Node generateRoundedNumberNode(int number) {
        var stackPane = new StackPane();
        stackPane.setNodeOrientation(NodeOrientation.LEFT_TO_RIGHT);

        var numberText = new Text(String.valueOf(number));
        numberText.setTextAlignment(TextAlignment.CENTER);
        numberText.setBoundsType(TextBoundsType.LOGICAL_VERTICAL_CENTER);
        numberText.setFill(Color.WHITE);
        numberText.setFont(Font.font(numberText.getFont().getFamily(), FontWeight.BOLD, 11));

        final double HEIGHT = 18.0;
        final double PADDING = 12.0;
        var rect = new Rectangle(getTextWidth(numberText) + PADDING, HEIGHT);
        rect.setArcWidth(HEIGHT);
        rect.setArcHeight(HEIGHT);
        rect.setFill(COLOR_ROUNDED_NUMBER);

        stackPane.getChildren().add(rect);
        stackPane.getChildren().add(numberText);

        return stackPane;
    }

    private double getTextWidth(Text text) {
        new Scene(new Group(text));
        text.applyCss();
        return text.getLayoutBounds().getWidth();
    }

    private Color selectColorForTitle(String title) {
        if (title == null) return COLOR_UNKNOWN;
        return COLORS_PALETTE[Math.abs(title.hashCode()) % COLORS_PALETTE.length];
    }

    /**
     * Displays an error dialog with the specified details.
     *
     * @param throwable    the {@link Throwable} associated with the error (optional).
     * @param errorCode    the error code to be displayed in the dialog.
     * @param errorDetails additional details about the error (optional).
     */
    public void showErrorDialog(Throwable throwable, LabelAndCode errorCode, String... errorDetails) {
        Log.errorf(throwable, "errorCode = %s | errorDetails = %s", errorCode, Arrays.toString(errorDetails));

        StringBuilder sb = new StringBuilder();
        if(errorDetails != null) {
            for(String s : errorDetails) sb.append(s).append("\n");
        }
        if(throwable != null) {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            throwable.printStackTrace(pw);
            String stacktraceText = sw.toString();
            sb.append(stacktraceText);
        }

        alertDialogFxController.setContent(Alert.AlertType.ERROR, "dialogs.error.title",
                "dialogs.error.header", errorCode.toString(), sb.toString(),
                new ButtonInfo("dialogs.buttons.close", ButtonBar.ButtonData.CANCEL_CLOSE));
        alertDialogFxController.showDialog();
    }

    /**
     * Displays a warning dialog with the specified message.
     *
     * @param messageText the message to be displayed
     */
    public void showWarningDialog(String messageText) {
        alertDialogFxController.setContent(Alert.AlertType.WARNING, "dialogs.warning.title",
                messageText, null, null,
                new ButtonInfo("dialogs.buttons.close", ButtonBar.ButtonData.CANCEL_CLOSE));
        alertDialogFxController.showDialog();
    }

    /**
     * Displays a confirmation dialog with the specified message.
     *
     * @param messageText the message to be displayed
     *
     * @return {@code true} if the user confirms the action, {@code false} otherwise.
     */
    public boolean showConfirmationDialog(String messageText) {
        alertDialogFxController.setContent(Alert.AlertType.CONFIRMATION, "dialogs.confirmation.title",
                messageText, null, null,
                new ButtonInfo("dialogs.buttons.yes", ButtonBar.ButtonData.YES),
                new ButtonInfo("dialogs.buttons.no", ButtonBar.ButtonData.NO));
        var buttonTypeOptional = alertDialogFxController.showDialog();
        return buttonTypeOptional.stream().anyMatch(bt -> bt.getButtonData() == ButtonBar.ButtonData.YES);
    }

    public void showHttpErrorDialog(int httpResponseStatusCode, String httpResponseBody) {
        httpErrorDialogFxController.setHttpResponse(httpResponseStatusCode, httpResponseBody);
        httpErrorDialogFxController.showDialog();
    }

    public void showErrorStacktraceDialog(Throwable throwable) {
        stacktraceDialogFxController.setException(throwable);
        stacktraceDialogFxController.showDialog();
    }
}
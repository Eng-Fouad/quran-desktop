package com.quran.labs.desktop.home.ui;

import com.quran.labs.desktop.core.data.GuiStateManager;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.animation.KeyFrame;
import javafx.animation.Timeline;
import javafx.collections.FXCollections;
import javafx.collections.ObservableList;
import javafx.event.ActionEvent;
import javafx.fxml.FXML;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Node;
import javafx.scene.control.*;
import javafx.scene.control.skin.VirtualFlow;
import javafx.scene.layout.*;
import javafx.util.Callback;
import javafx.util.Duration;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.fx.MountableFxController;
import com.quran.labs.desktop.core.ui.GuiFactory;
import com.quran.labs.desktop.core.ui.MainFxController;
import com.quran.labs.desktop.home.dto.ChatDescriptor;
import com.quran.labs.desktop.home.dto.ChatType;
import com.quran.labs.desktop.home.dto.MessageDeliveryStatus;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
public class ChatListFxController extends FxControllerBase implements MountableFxController, LanguageChangeAware {

    @Inject MainFxController mainFxController;
    @Inject GuiFactory guiFactory;
    @Inject GuiStateManager guiStateManager;

    @FXML Tab tabChaptersList;
    @FXML Tab tabBookmarks;
    @FXML ListView<ChatDescriptor> lvChaptersList;
    @FXML ListView<?> lvBookmarks; // TODO

    private static final Map<ChatDescriptor, Node> NODES_CACHE = new HashMap<>();
    private static final Duration PROBE_FREQUENCY = Duration.seconds(2);
    ObservableList<ChatDescriptor> chatDescriptors;
    Timeline timeline;
    VirtualFlow<?> virtualFlow;

    @Override
    protected void initialize() {
        // Temp test data
        chatDescriptors = FXCollections.observableArrayList();
        lvChaptersList.setItems(chatDescriptors);
        lvChaptersList.setCellFactory(newChatListCellFactory());

        timeline = new Timeline(new KeyFrame(Duration.ZERO, this::onTick), new KeyFrame(PROBE_FREQUENCY));
        timeline.setCycleCount(Timeline.INDEFINITE);
    }

    @Override
    public void onMount() {
        timeline.play();
    }

    @Override
    public void onDismount() {
        timeline.stop();
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        tabChaptersList.setText(resources.getString("label.chaptersList"));
        tabBookmarks.setText(resources.getString("label.bookmarks"));
        timeline.playFromStart();
    }

    void onTick(ActionEvent actionEvent) {
        for (var entry : NODES_CACHE.entrySet()) {
            var chatDescriptor = entry.getKey();
            var node = entry.getValue();
            var timestampLabel = (Label) node.lookup("#lblTimestamp");
        }
    }

    private Callback<ListView<ChatDescriptor>, ListCell<ChatDescriptor>> newChatListCellFactory() {
        return new Callback<>() {
            @Override
            public ListCell<ChatDescriptor> call(ListView<ChatDescriptor> param) {
                return new ListCell<>() {
                    @Override
                    protected void updateItem(ChatDescriptor item, boolean empty) {
                        super.updateItem(item, empty);

                        setText(null);
                        if (empty || item == null) {
                            setGraphic(null);
                        } else {
                            Node cellNode;
                            if (NODES_CACHE.containsKey(item)) {
                                cellNode = NODES_CACHE.get(item);
                            } else {
                                var borderPane = new BorderPane();
                                borderPane.setPrefWidth(1.0); // this makes inner labels shrinking

                                var avatarNode = guiFactory.generateAvatarNode(item.chatType(), item.title(), 25.0);
                                borderPane.setLeft(avatarNode);

                                var vBox = new VBox();
                                vBox.setPadding(new Insets(5.0, 0.0, 0.0, 0.0));
                                borderPane.setCenter(vBox);

                                var topLinePane = new HBox();
                                vBox.getChildren().add(topLinePane);

                                var titleLabel = new Label();
                                titleLabel.getStyleClass().add("title-label");
                                titleLabel.setAlignment(Pos.CENTER_LEFT);
                                titleLabel.setText(item.title());
                                topLinePane.getChildren().add(titleLabel);

                                if (item.muted()) {
                                    var mutedChatIcon = new Label();
                                    mutedChatIcon.setMinWidth(20.0);
                                    mutedChatIcon.setAlignment(Pos.CENTER_LEFT);
                                    mutedChatIcon.setGraphic(guiFactory.generateMutedChatIcon());
                                    mutedChatIcon.setPadding(new Insets(0.0, 0.0, 0.0, 5.0));
                                    topLinePane.getChildren().add(mutedChatIcon);
                                }

                                var topGapRegion = new Region();
                                HBox.setHgrow(topGapRegion, Priority.ALWAYS);
                                topLinePane.getChildren().add(topGapRegion);

                                var timestampLabel = new Label();
                                timestampLabel.setId("lblTimestamp");
                                timestampLabel.setAlignment(Pos.CENTER_RIGHT);
                                timestampLabel.setMinWidth(Label.USE_PREF_SIZE); // prevent label shrinking (ellipsis)
                                timestampLabel.setPadding(new Insets(0.0, 0.0, 0.0, 5.0));
                                timestampLabel.getStyleClass().add("timestamp-label");
                                topLinePane.getChildren().add(timestampLabel);

                                var bottomLinePane = new HBox();
                                vBox.getChildren().add(bottomLinePane);

                                var lastMessageTextLabel = new Label();
                                lastMessageTextLabel.setWrapText(true);
                                lastMessageTextLabel.setMaxHeight(40.0);
                                lastMessageTextLabel.getStyleClass().add("last-message-text-label");
                                lastMessageTextLabel.setAlignment(Pos.TOP_LEFT);
                                lastMessageTextLabel.setMinHeight(30.0);
                                lastMessageTextLabel.setText(item.lastMessageText());
                                bottomLinePane.getChildren().add(lastMessageTextLabel);

                                var bottomGapRegion = new Region();
                                HBox.setHgrow(bottomGapRegion, Priority.ALWAYS);
                                bottomLinePane.getChildren().add(bottomGapRegion);

                                Node icon = null;
                                if (item.unreadCount() > 0) {
                                    icon = guiFactory.generateRoundedNumberNode(item.unreadCount());
                                } else if (item.messageDeliveryStatus() != null) {
                                    icon = guiFactory.generateMessageDeliveryStatusIcon(item.messageDeliveryStatus());
                                }
                                if (icon != null) {
                                    var iconLabel = new Label();
                                    iconLabel.setAlignment(Pos.TOP_RIGHT);
                                    iconLabel.setMinWidth(20.0);
                                    iconLabel.setGraphic(icon);
                                    iconLabel.setPadding(new Insets(0.0, 0.0, 0.0, 5.0));
                                    bottomLinePane.getChildren().add(iconLabel);
                                }

                                cellNode = NODES_CACHE.put(item, borderPane);
                            }
                            setGraphic(cellNode);
                        }
                    }
                };
            }
        };
    }

    @FXML
    void onAdd() {
        VirtualFlow<?> virtualFlow;
        try {
            var field = lvChaptersList.getSkin().getClass().getDeclaredField("flow");
            field.setAccessible(true);
            virtualFlow = (VirtualFlow<?>) field.get(lvChaptersList.getSkin());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }

        boolean lastCellVisible = virtualFlow.getLastVisibleCell().getIndex() == chatDescriptors.size() - 1;
        double position = virtualFlow.getPosition();
        double height = virtualFlow.getFirstVisibleCell().getLayoutBounds().getHeight();
        chatDescriptors.addFirst(new ChatDescriptor(ChatType.INDIVIDUAL, new Object().toString(), new Object().toString(), Instant.now(), 123, false, MessageDeliveryStatus.SENDING));

        if (position == 0.0) {
            lvChaptersList.scrollTo(0);
        } else if (position == 1.0) {
            lvChaptersList.scrollTo(chatDescriptors.size() - 1);
        } else {
            double pixels = virtualFlow.scrollPixels(height);
            if (lastCellVisible) {
                lvChaptersList.scrollTo(chatDescriptors.size() - 1);
                virtualFlow.scrollPixels(-pixels);
            }
        }
        lvChaptersList.refresh();
    }
}
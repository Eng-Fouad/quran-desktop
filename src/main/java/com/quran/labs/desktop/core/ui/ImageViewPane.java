package com.quran.labs.desktop.core.ui;

import io.quarkus.runtime.annotations.RegisterForReflection;
import javafx.beans.NamedArg;
import javafx.beans.property.BooleanProperty;
import javafx.beans.property.ObjectProperty;
import javafx.beans.property.SimpleBooleanProperty;
import javafx.beans.property.SimpleObjectProperty;
import javafx.geometry.HPos;
import javafx.geometry.VPos;
import javafx.scene.image.ImageView;
import javafx.scene.layout.Region;

@RegisterForReflection
public class ImageViewPane extends Region {

	private ObjectProperty<ImageView> imageViewProperty = new SimpleObjectProperty<>();
	
	public ImageViewPane(@NamedArg("imageView") ImageView imageView) {
		imageViewProperty.addListener((_, oldIV, newIV) -> {
		    if(oldIV != null) getChildren().remove(oldIV);
		    if(newIV != null) getChildren().add(newIV);
		});
		this.imageViewProperty.set(imageView);
	}
	
	public ObjectProperty<ImageView> imageViewProperty() {
		return imageViewProperty;
	}
	
	public ImageView getImageView() {
		return imageViewProperty.get();
	}
	
	public void setImageView(ImageView imageView) {
		this.imageViewProperty.set(imageView);
	}
	
	public ImageViewPane() {
		this(new ImageView());
	}

	private BooleanProperty fitHeight;
	public final void setFitHeight(boolean value) {
		fitHeightProperty().set(value);
	}
	public final boolean getFitHeight() {
		return fitHeight != null && fitHeight.get();
	}
	public final BooleanProperty fitHeightProperty() {
		if (fitHeight == null) {
			fitHeight = new SimpleBooleanProperty(this, "mnemonicParsing");
		}
		return fitHeight;
	}

	private BooleanProperty fitWidth;
	public final void setFitWidth(boolean value) {
		fitWidthProperty().set(value);
	}
	public final boolean getFitWidth() {
		return fitWidth != null && fitWidth.get();
	}
	public final BooleanProperty fitWidthProperty() {
		if (fitWidth == null) {
			fitWidth = new SimpleBooleanProperty(this, "mnemonicParsing");
		}
		return fitWidth;
	}
	
	@Override
	protected void layoutChildren() {
		ImageView imageView = imageViewProperty.get();
		
		if(imageView != null) {
			if (getFitWidth()) imageView.setFitWidth(getWidth());
			if (getFitHeight()) imageView.setFitHeight(getHeight());
			layoutInArea(imageView, 0, 0, getWidth(), getHeight(),
			             0, HPos.CENTER, VPos.CENTER);
		}
		
		super.layoutChildren();
	}
}
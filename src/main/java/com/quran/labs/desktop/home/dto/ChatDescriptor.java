package com.quran.labs.desktop.home.dto;

import java.time.Instant;

public record ChatDescriptor(
    ChatType chatType,
    String title,
    String lastMessageText,
    Instant lastMessageTimestamp,
    int unreadCount,
    boolean muted,
    MessageDeliveryStatus messageDeliveryStatus
){}
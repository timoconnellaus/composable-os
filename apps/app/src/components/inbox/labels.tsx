// The shared inbox's small pieces (stage 36 step 3): a conversation's status, who it is with, and
// its marks (private, unknown or unverified sender), as the inbox list, a conversation's page and a
// Person's Conversations tab show them. Everything here shows what the operations returned: a
// conversation the caller may not read never reaches these.
import type { CoreOutput } from "@composable-os/core";
import { Badge } from "@composable-os/ui/components/badge";
import {
  LockIcon,
  MailIcon,
  MessageCircleIcon,
  ShieldAlertIcon,
  UserRoundXIcon,
} from "lucide-react";

export type Conversation = CoreOutput<"conversation.get">["conversation"];
export type ConversationStatus = Conversation["status"];
export type ConversationChannel = Conversation["channel"];

export const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Open",
  waiting: "Waiting on them",
  closed: "Closed",
};

export const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  email: "Email",
  chat: "Chat",
};

export function StatusBadge({ status, testId }: { status: ConversationStatus; testId?: string }) {
  return (
    <Badge
      variant={status === "open" ? "default" : status === "waiting" ? "secondary" : "outline"}
      data-state={status}
      data-testid={testId}
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function ChannelIcon({ channel }: { channel: ConversationChannel }) {
  const Icon = channel === "chat" ? MessageCircleIcon : MailIcon;
  return (
    <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={CHANNEL_LABELS[channel]} />
  );
}

/** Who a conversation is with: the Person's name, or the unknown sender's address. */
export function conversationWho(
  conversation: Pick<Conversation, "person" | "unknownSender">,
): string {
  if (conversation.person) return conversation.person.name ?? "A person";
  return conversation.unknownSender ?? "Unknown sender";
}

/** The marks a conversation carries, as small badges. */
export function ConversationMarks({
  conversation,
}: {
  conversation: Pick<Conversation, "private" | "person" | "senderUnverified">;
}) {
  return (
    <>
      {conversation.private && (
        <Badge variant="outline" data-testid="mark-private">
          <LockIcon aria-hidden />
          Private
        </Badge>
      )}
      {!conversation.person && (
        <Badge variant="outline" data-testid="mark-unknown">
          <UserRoundXIcon aria-hidden />
          Unknown sender
        </Badge>
      )}
      {conversation.senderUnverified && (
        <Badge variant="destructive" data-testid="mark-unverified">
          <ShieldAlertIcon aria-hidden />
          Unverified sender
        </Badge>
      )}
    </>
  );
}

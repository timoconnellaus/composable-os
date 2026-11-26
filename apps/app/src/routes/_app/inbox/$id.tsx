// One conversation (stage 36 step 3): its messages and staff notes in order (conversation.get),
// the reply box, and beside them who has it (take, assign), its status, category and private mark,
// who it is with (an unknown sender is linked to a Person here), what it is about, and the
// person's other conversations. Asked again every 15 seconds while open, so two staff on one
// conversation see who took it; a write carries the version it read and is refused when the
// conversation changed meanwhile.
//
// Messages are what people wrote: shown as plain text (React escapes it), never as HTML, and the
// host never follows their links. A private conversation the caller may not read is "not found".
import type { CoreOutput } from "@composable-os/core";
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@composable-os/ui/components/dialog";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Switch } from "@composable-os/ui/components/switch";
import { cn } from "@composable-os/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { InboxIcon, StickyNoteIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { Composer, type StaffOption } from "#/components/inbox/composer";
import {
  CHANNEL_LABELS,
  ChannelIcon,
  type Conversation,
  ConversationMarks,
  type ConversationStatus,
  conversationWho,
  STATUS_LABELS,
  StatusBadge,
} from "#/components/inbox/labels";
import { PageLayout } from "#/components/layout/page-layout";
import { RecordPicker } from "#/components/record-picker";
import { formatDateTime, formatRelative } from "#/lib/format";
import { callOp, OperationCallError } from "#/lib/operations";
import { errorMessage, invalidateOps, useOp, useOpMutation } from "#/lib/query";
import { recordHref } from "#/lib/schema";
import { ALL_USERS_INPUT } from "#/lib/users-adapter";

export const Route = createFileRoute("/_app/inbox/$id")({ component: ConversationPage });

type Message = CoreOutput<"conversation.get">["messages"][number];
const NOBODY = "nobody";

function ConversationPage() {
  const { id } = Route.useParams();
  const { user } = Route.useRouteContext();
  const works = user.role !== "viewer";
  const read = useOp("conversation.get", { id }, { refetchInterval: 15_000 });
  const users = useOp("user.list", ALL_USERS_INPUT, { staleTime: 60_000 });
  // Who may have a conversation: staff who work the inbox (the host checks again).
  const workers: StaffOption[] = useMemo(
    () =>
      (users.data?.items ?? [])
        .filter((u) => u.packRole === null && (u.role === "admin" || u.role === "member"))
        .map((u) => ({ id: u.id, name: u.name || u.email || u.id })),
    [users.data],
  );
  const readers: StaffOption[] = useMemo(
    () =>
      (users.data?.items ?? [])
        .filter((u) => u.packRole === null && u.id !== user.id)
        .map((u) => ({ id: u.id, name: u.name || u.email || u.id })),
    [users.data, user.id],
  );

  if (read.isPending) {
    return (
      <PageLayout title="Conversation" width="xl" back={{ to: "/inbox", label: "Inbox" }}>
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </PageLayout>
    );
  }
  if (read.isError) {
    const notFound = read.error instanceof OperationCallError && read.error.code === "not_found";
    return (
      <PageLayout title="Conversation" width="xl" back={{ to: "/inbox", label: "Inbox" }}>
        {notFound ? (
          <EmptyState
            icon={InboxIcon}
            title="Conversation not found"
            description="It may have been removed, or it is private."
          />
        ) : (
          <ErrorState
            title="Could not load this conversation"
            error={read.error}
            onRetry={() => void read.refetch()}
          />
        )}
      </PageLayout>
    );
  }

  const { conversation, messages, earlierCursor, otherConversations } = read.data;
  return (
    <PageLayout
      title={conversationWho(conversation)}
      titleAddon={
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge status={conversation.status} testId="conversation-status" />
          <ConversationMarks conversation={conversation} />
        </div>
      }
      description={
        <span className="flex items-center gap-1">
          <ChannelIcon channel={conversation.channel} />
          {conversation.subject ?? "(no subject)"}
        </span>
      }
      width="xl"
      back={{ to: "/inbox", label: "Inbox" }}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-4">
          <Thread
            conversationId={conversation.id}
            them={conversationWho(conversation)}
            messages={messages}
            earlier={earlierCursor}
          />
          {works && (
            <Composer
              conversationId={conversation.id}
              channel={conversation.channel}
              staff={readers}
            />
          )}
        </div>
        <div className="grid content-start gap-4">
          <WorkCard conversation={conversation} works={works} workers={workers} userId={user.id} />
          <PersonCard conversation={conversation} works={works} others={otherConversations} />
          <AboutCard conversation={conversation} works={works} />
        </div>
      </div>
    </PageLayout>
  );
}

// --- The thread ---------------------------------------------------------------------------------

function Thread({
  conversationId,
  them,
  messages,
  earlier,
}: {
  conversationId: string;
  /** Who wrote the inbound messages. */
  them: string;
  messages: Message[];
  earlier: string | null;
}) {
  // Earlier pages read by "Show earlier", oldest first, before the latest page.
  const [older, setOlder] = useState<{ messages: Message[]; cursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const cursor = older ? older.cursor : earlier;

  async function showEarlier() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await callOp("conversation.get", { id: conversationId, before: cursor });
      setOlder((o) => ({
        messages: [...page.messages, ...(o?.messages ?? [])],
        cursor: page.earlierCursor,
      }));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  const all = [...(older?.messages ?? []), ...messages];
  return (
    <section aria-label="Messages" className="grid gap-3">
      {cursor && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => void showEarlier()}
          disabled={loading}
        >
          {loading ? "Loading…" : "Show earlier messages"}
        </Button>
      )}
      {all.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
      <ol className="grid gap-3">
        {all.map((m) => (
          <MessageItem key={m.id} message={m} them={them} />
        ))}
      </ol>
    </section>
  );
}

function MessageItem({ message, them }: { message: Message; them: string }) {
  const note = message.kind === "note";
  const outbound = message.direction === "outbound";
  const who = note
    ? (message.author.name ?? "Staff")
    : outbound
      ? (message.author.name ?? "You")
      : them;
  return (
    <li
      className={cn(
        "grid gap-1 rounded-md border p-3",
        note && "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30",
        outbound && "bg-muted/40",
      )}
      data-testid={note ? "conversation-note" : "conversation-message"}
      data-direction={message.direction ?? "note"}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {note && <StickyNoteIcon className="size-4 text-amber-700" aria-hidden />}
        <span className="font-medium">{note ? `Note by ${who}` : who}</span>
        {note && <Badge variant="outline">Staff only</Badge>}
        {message.subject && !note && (
          <span className="min-w-0 truncate text-muted-foreground">{message.subject}</span>
        )}
        <time
          dateTime={message.occurredAt}
          title={formatDateTime(message.occurredAt)}
          className="ml-auto text-xs text-muted-foreground"
        >
          {formatRelative(message.occurredAt)}
        </time>
      </div>
      <MessageBody message={message} />
    </li>
  );
}

/** A message's text, as text; the full email from blob storage on request, as text too. */
function MessageBody({ message }: { message: Message }) {
  const [full, setFull] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (full !== null) {
      setOpen((v) => !v);
      return;
    }
    setLoading(true);
    try {
      const out = await callOp("activity.getBody", { id: message.id });
      setFull(out.body ?? "");
      setOpen(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  const text = open && full !== null ? full : message.body;
  return (
    <>
      {text && (
        <p
          className={cn(
            "text-sm break-words whitespace-pre-wrap",
            open && "max-h-[32rem] overflow-y-auto",
          )}
          data-testid="message-body"
        >
          {text}
        </p>
      )}
      {message.hasFullBody && (
        <Button
          variant="link"
          size="xs"
          className="h-auto w-fit px-0"
          aria-expanded={open}
          disabled={loading}
          onClick={() => void toggle()}
        >
          {loading ? "Loading…" : open ? "Show less" : "Show full email"}
        </Button>
      )}
    </>
  );
}

// --- Working it ---------------------------------------------------------------------------------

/** A write that refetches the conversation and the inbox, with the conflict said plainly. */
function useConversationWrite() {
  const client = useQueryClient();
  return async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) toast.success(done);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      await Promise.all([invalidateOps(client, "conversation."), invalidateOps(client, "inbox.")]);
    }
  };
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function WorkCard({
  conversation,
  works,
  workers,
  userId,
}: {
  conversation: Conversation;
  works: boolean;
  workers: StaffOption[];
  userId: string;
}) {
  const write = useConversationWrite();
  const take = useOpMutation("conversation.take");
  const assign = useOpMutation("conversation.assign");
  const setStatus = useOpMutation("conversation.setStatus");
  const setCategory = useOpMutation("conversation.setCategory");
  const setPrivate = useOpMutation("conversation.setPrivate");
  const categories = useOp("inbox.categories", {}, { staleTime: 60_000 });
  const version = conversation.version;
  const mine = conversation.assignee?.id === userId;
  const options =
    workers.some((w) => w.id === conversation.assignee?.id) || !conversation.assignee
      ? workers
      : [
          ...workers,
          { id: conversation.assignee.id, name: conversation.assignee.name ?? "Someone" },
        ];
  const categoryList = categories.data?.categories ?? [];
  const categoryOptions =
    conversation.category && !categoryList.includes(conversation.category)
      ? [...categoryList, conversation.category]
      : categoryList;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Who has it</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm" data-testid="assignee">
          {conversation.assignee
            ? mine
              ? "You have it"
              : `${conversation.assignee.name ?? "Someone"} has it`
            : "Nobody has it yet"}
        </p>
        {works && (
          <>
            {!mine && !conversation.assignee && (
              <Button
                size="sm"
                className="w-fit"
                disabled={take.isPending}
                onClick={() =>
                  void write(
                    () => take.mutateAsync({ id: conversation.id, version }),
                    "You have this conversation",
                  )
                }
              >
                Take it
              </Button>
            )}
            <Field label="Give it to" htmlFor="assignee">
              <Select
                value={conversation.assignee?.id ?? NOBODY}
                onValueChange={(v) =>
                  void write(
                    () =>
                      assign.mutateAsync({
                        id: conversation.id,
                        assigneeId: v === NOBODY ? null : v,
                        version,
                      }),
                    v === NOBODY ? "Nobody has it now" : "Handed over",
                  )
                }
              >
                <SelectTrigger id="assignee" size="sm" aria-label="Give it to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOBODY}>Nobody</SelectItem>
                  {options.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.id === userId ? `${w.name} (you)` : w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Status" htmlFor="status">
              <Select
                value={conversation.status}
                onValueChange={(v) =>
                  void write(() =>
                    setStatus.mutateAsync({
                      id: conversation.id,
                      status: v as ConversationStatus,
                      version,
                    }),
                  )
                }
              >
                <SelectTrigger id="status" size="sm" aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(STATUS_LABELS) as ConversationStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {categoryOptions.length > 0 && (
              <Field label="Category" htmlFor="category">
                <Select
                  value={conversation.category ?? NOBODY}
                  onValueChange={(v) =>
                    void write(() =>
                      setCategory.mutateAsync({
                        id: conversation.id,
                        category: v === NOBODY ? null : v,
                        version,
                      }),
                    )
                  }
                >
                  <SelectTrigger id="category" size="sm" aria-label="Category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NOBODY}>None</SelectItem>
                    {categoryOptions.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <div className="flex items-start gap-3">
              <Switch
                id="private"
                checked={conversation.private}
                disabled={setPrivate.isPending}
                onCheckedChange={(on) =>
                  void write(
                    () => setPrivate.mutateAsync({ id: conversation.id, private: on, version }),
                    on
                      ? "Only admins and whoever has it see it now"
                      : "Everyone on the inbox sees it now",
                  )
                }
              />
              <div className="grid gap-0.5">
                <Label htmlFor="private">Private</Label>
                <p className="text-xs text-muted-foreground">
                  Only admins and whoever has it see it, its messages and notes.
                </p>
              </div>
            </div>
          </>
        )}
        {!works && (
          <dl className="grid gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Status</dt>
              <dd>{STATUS_LABELS[conversation.status]}</dd>
            </div>
            {conversation.category && (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Category</dt>
                <dd>{conversation.category}</dd>
              </div>
            )}
          </dl>
        )}
        <dl className="grid gap-1 text-xs text-muted-foreground">
          <div className="flex justify-between gap-2">
            <dt>Channel</dt>
            <dd>{CHANNEL_LABELS[conversation.channel]}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Opened</dt>
            <dd>{formatDateTime(conversation.openedAt)}</dd>
          </div>
          {conversation.lastReplyAt && (
            <div className="flex justify-between gap-2">
              <dt>Last reply</dt>
              <dd>{formatDateTime(conversation.lastReplyAt)}</dd>
            </div>
          )}
          {conversation.closedAt && (
            <div className="flex justify-between gap-2">
              <dt>Closed</dt>
              <dd>{formatDateTime(conversation.closedAt)}</dd>
            </div>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

function PersonCard({
  conversation,
  works,
  others,
}: {
  conversation: Conversation;
  works: boolean;
  others: CoreOutput<"conversation.get">["otherConversations"];
}) {
  const write = useConversationWrite();
  const link = useOpMutation("conversation.linkPerson", { invalidates: ["person.", "activity."] });
  const [making, setMaking] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Who it is with</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {conversation.person ? (
          <Link
            to="/people/$id"
            params={{ id: conversation.person.id }}
            className="font-medium hover:underline"
            data-testid="conversation-person"
          >
            {conversation.person.name ?? "Open person"}
          </Link>
        ) : (
          <>
            <p>
              <span className="break-all font-medium">{conversation.unknownSender}</span> matches
              nobody in your records.
            </p>
            {works && (
              <>
                <RecordPicker
                  object="person"
                  value={null}
                  label="Link to a person"
                  placeholder="Link to a person…"
                  onChange={(picked) => {
                    if (!picked) return;
                    void write(
                      () =>
                        link.mutateAsync({
                          id: conversation.id,
                          personId: picked.id,
                          version: conversation.version,
                        }),
                      `Linked to ${picked.name}`,
                    );
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setMaking(true)}
                >
                  Make a person
                </Button>
                <MakePersonDialog
                  open={making}
                  onOpenChange={setMaking}
                  conversation={conversation}
                />
              </>
            )}
          </>
        )}
        {others.length > 0 && (
          <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">Their other conversations</p>
            <ul className="grid gap-1">
              {others.map((o) => (
                <li key={o.id} className="flex items-center gap-2">
                  <ChannelIcon channel={o.channel} />
                  <Link
                    to="/inbox/$id"
                    params={{ id: o.id }}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {o.subject ?? "(no subject)"}
                  </Link>
                  <span className="text-xs text-muted-foreground">{STATUS_LABELS[o.status]}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Make a Person from an unknown sender (person.create), then link the conversation to them. */
function MakePersonDialog({
  open,
  onOpenChange,
  conversation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: Conversation;
}) {
  const write = useConversationWrite();
  const client = useQueryClient();
  const [given, setGiven] = useState("");
  const [family, setFamily] = useState("");
  const [busy, setBusy] = useState(false);
  const address = conversation.unknownSender ?? "";

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!given.trim()) return;
    setBusy(true);
    await write(async () => {
      const person = await callOp("person.create", {
        givenName: given.trim(),
        ...(family.trim() ? { familyName: family.trim() } : {}),
        ...(address ? { emails: [{ email: address }] } : {}),
      });
      await callOp("conversation.linkPerson", {
        id: conversation.id,
        personId: person.id,
        version: conversation.version,
      });
      await invalidateOps(client, "person.");
      onOpenChange(false);
    }, "Person made and linked");
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Make a person</DialogTitle>
            <DialogDescription>
              A new person with the address {address}, and this conversation moves onto their
              timeline.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="make-given">Given name</Label>
            <Input id="make-given" value={given} onChange={(e) => setGiven(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="make-family">Family name</Label>
            <Input id="make-family" value={family} onChange={(e) => setFamily(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !given.trim()}>
              Make and link
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AboutCard({ conversation, works }: { conversation: Conversation; works: boolean }) {
  const write = useConversationWrite();
  const setAbout = useOpMutation("conversation.setAbout");
  if (!conversation.about) return null;
  const about = conversation.about;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What it is about</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <a href={recordHref(about.object, about.id)} className="font-medium hover:underline">
          {about.title ?? `${about.object} ${about.id}`}
        </a>
        {works && (
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() =>
              void write(() =>
                setAbout.mutateAsync({
                  id: conversation.id,
                  about: null,
                  version: conversation.version,
                }),
              )
            }
          >
            Not about it
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

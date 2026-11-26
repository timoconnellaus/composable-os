// A conversation's reply box (stage 36 step 3): "Reply" (the words for the person, with saved
// replies whose slots the host fills) and "Note" (staff only, never sent, with mentions).
//
// Sending a reply is `message.send`, which comes with email in and out (step 2) and chat for
// customers (step 4): until then the Reply tab holds the words and says sending is not on yet,
// and nothing here sends or records a reply. "Draft with AI" is step 6's.
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@composable-os/ui/components/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@composable-os/ui/components/tabs";
import { Textarea } from "@composable-os/ui/components/textarea";
import { Link } from "@tanstack/react-router";
import { AtSignIcon, MessageSquareTextIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import type { ConversationChannel } from "./labels.tsx";

const SLOT_WORDS: Record<string, string> = {
  "person.firstName": "the person's first name",
  "staff.firstName": "your first name",
  "business.name": "the business's name",
};

export interface StaffOption {
  id: string;
  name: string;
}

export function Composer({
  conversationId,
  channel,
  staff,
}: {
  conversationId: string;
  channel: ConversationChannel;
  /** Staff who read the inbox: who a note may mention (the host checks each). */
  staff: StaffOption[];
}) {
  const [tab, setTab] = useState<"reply" | "note">("reply");
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const writeNote = useOpMutation("message.note", { invalidates: ["conversation.", "inbox."] });

  async function insertSaved(id: string) {
    try {
      const filled = await callOp("savedReply.fill", { id, conversationId });
      setReply((text) =>
        text.trim() ? `${text.replace(/\s+$/, "")}\n\n${filled.body}` : filled.body,
      );
      setMissing(filled.missing);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function onNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    try {
      await writeNote.mutateAsync({ id: conversationId, body: note, mentions });
      setNote("");
      setMentions([]);
      toast.success("Note added");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const named = (id: string) => staff.find((s) => s.id === id)?.name ?? id;

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as "reply" | "note")}
      className="rounded-md border p-3"
    >
      <TabsList>
        <TabsTrigger value="reply">Reply</TabsTrigger>
        <TabsTrigger value="note">Note</TabsTrigger>
      </TabsList>
      <TabsContent value="reply" className="grid gap-2">
        <Textarea
          aria-label="Reply"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={6}
          placeholder={`Write your reply by ${channel === "chat" ? "chat" : "email"}…`}
        />
        {missing.length > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
            Nothing to fill in for {missing.map((m) => SLOT_WORDS[m] ?? m).join(", ")}: check the
            words before you send.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <SavedReplyMenu channel={channel} onPick={(id) => void insertSaved(id)} />
          <Button type="button" className="ml-auto" disabled aria-describedby="send-off">
            Send
          </Button>
        </div>
        <p id="send-off" className="text-xs text-muted-foreground" data-testid="send-off">
          Sending from the inbox is not switched on yet. Keep the team in the loop with a note.
        </p>
      </TabsContent>
      <TabsContent value="note">
        <form className="grid gap-2" onSubmit={(e) => void onNote(e)}>
          <Textarea
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="A note for the team. It is never sent to the person."
            className="bg-amber-50/50 dark:bg-amber-950/20"
          />
          {mentions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {mentions.map((id) => (
                <Badge key={id} variant="secondary">
                  @{named(id)}
                  <button
                    type="button"
                    aria-label={`Do not mention ${named(id)}`}
                    onClick={() => setMentions((m) => m.filter((x) => x !== id))}
                  >
                    <XIcon className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <AtSignIcon />
                  Mention
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                <DropdownMenuLabel>Tell someone</DropdownMenuLabel>
                {staff.map((s) => (
                  <DropdownMenuCheckboxItem
                    key={s.id}
                    checked={mentions.includes(s.id)}
                    onCheckedChange={(on) =>
                      setMentions((m) => (on ? [...m, s.id] : m.filter((x) => x !== s.id)))
                    }
                  >
                    {s.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="submit"
              className="ml-auto"
              disabled={!note.trim() || writeNote.isPending}
            >
              Add note
            </Button>
          </div>
        </form>
      </TabsContent>
    </Tabs>
  );
}

/** The saved replies that fit the channel: the shared ones and the caller's own. */
function SavedReplyMenu({
  channel,
  onPick,
}: {
  channel: ConversationChannel;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const list = useOp("savedReply.list", { channel, limit: 100 }, { enabled: open });
  const items = list.data?.items ?? [];
  const shared = items.filter((r) => r.shared);
  const mine = items.filter((r) => !r.shared);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <MessageSquareTextIcon />
          Saved replies
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        {list.isPending ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            Loading…
          </DropdownMenuLabel>
        ) : items.length === 0 ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            No saved replies for {channel === "chat" ? "chat" : "email"} yet
          </DropdownMenuLabel>
        ) : (
          <>
            {shared.length > 0 && <DropdownMenuLabel>Shared</DropdownMenuLabel>}
            {shared.map((r) => (
              <DropdownMenuItem key={r.id} onSelect={() => onPick(r.id)}>
                <span className="truncate">{r.title}</span>
              </DropdownMenuItem>
            ))}
            {mine.length > 0 && <DropdownMenuLabel>Yours</DropdownMenuLabel>}
            {mine.map((r) => (
              <DropdownMenuItem key={r.id} onSelect={() => onPick(r.id)}>
                <span className="truncate">{r.title}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/inbox/saved-replies">Manage saved replies</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

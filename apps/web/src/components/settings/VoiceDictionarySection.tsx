import type { VoiceDictionaryEntry } from "@t3tools/contracts";
import { DownloadIcon, PencilIcon, PlusIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetTitle,
} from "../ui/sheet";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";
import { parseDictionaryImport, serializeDictionary } from "./VoiceSettingsPanel.logic";

interface DictionaryDraft {
  readonly type: "term" | "alias";
  readonly originals: string;
  readonly replacement: string;
  readonly caseSensitive: boolean;
  readonly fuzzy: boolean;
}

const EMPTY_DRAFT: DictionaryDraft = {
  type: "alias",
  originals: "",
  replacement: "",
  caseSensitive: false,
  fuzzy: false,
};

function draftToEntry(draft: DictionaryDraft, id = randomUUID()): VoiceDictionaryEntry | null {
  const originals = draft.originals
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (originals.length === 0) return null;
  const replacement = draft.replacement.trim();
  if (draft.type === "alias" && !replacement) return null;
  return {
    id,
    type: draft.type,
    originals,
    ...(replacement ? { replacement } : {}),
    caseSensitive: draft.caseSensitive,
    fuzzy: draft.fuzzy,
    enabled: true,
  };
}

function DictionaryFields(props: {
  readonly draft: DictionaryDraft;
  readonly onChange: (draft: DictionaryDraft) => void;
  readonly disabled: boolean;
}) {
  const typeItems = [
    { label: "Alias", value: "alias" as const },
    { label: "Term", value: "term" as const },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Select
        items={typeItems}
        value={props.draft.type}
        onValueChange={(value) => {
          if (value) props.onChange({ ...props.draft, type: value });
        }}
        disabled={props.disabled}
      >
        <SelectTrigger aria-label="Dictionary entry type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {typeItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Input
        value={props.draft.originals}
        onChange={(event) =>
          props.onChange({ ...props.draft, originals: event.currentTarget.value })
        }
        placeholder="Spoken forms, separated by commas"
        aria-label="Spoken forms"
        disabled={props.disabled}
      />
      {props.draft.type === "alias" ? (
        <Input
          value={props.draft.replacement}
          onChange={(event) =>
            props.onChange({ ...props.draft, replacement: event.currentTarget.value })
          }
          placeholder="Replacement"
          aria-label="Replacement"
          disabled={props.disabled}
        />
      ) : null}
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={props.draft.caseSensitive}
            onCheckedChange={(checked) =>
              props.onChange({ ...props.draft, caseSensitive: checked })
            }
            disabled={props.disabled}
          />
          Case-sensitive
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={props.draft.fuzzy}
            onCheckedChange={(checked) => props.onChange({ ...props.draft, fuzzy: checked })}
            disabled={props.disabled}
          />
          Fuzzy match
        </label>
      </div>
    </div>
  );
}

export function VoiceDictionarySection(props: {
  readonly entries: ReadonlyArray<VoiceDictionaryEntry>;
  readonly onChange: (entries: ReadonlyArray<VoiceDictionaryEntry>) => void;
  readonly degraded: boolean;
}) {
  const [draft, setDraft] = useState<DictionaryDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<VoiceDictionaryEntry | null>(null);
  const [editDraft, setEditDraft] = useState<DictionaryDraft>(EMPTY_DRAFT);
  const importRef = useRef<HTMLInputElement | null>(null);

  const addEntry = () => {
    const entry = draftToEntry(draft);
    if (!entry) {
      toastManager.add({
        type: "error",
        title: draft.type === "alias" ? "Add spoken forms and a replacement." : "Add a term.",
      });
      return;
    }
    props.onChange([...props.entries, entry]);
    setDraft(EMPTY_DRAFT);
  };

  const openEdit = (entry: VoiceDictionaryEntry) => {
    setEditing(entry);
    setEditDraft({
      type: entry.type,
      originals: entry.originals.join(", "),
      replacement: entry.replacement ?? "",
      caseSensitive: entry.caseSensitive,
      fuzzy: entry.fuzzy,
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    const entry = draftToEntry(editDraft, editing.id);
    if (!entry) return;
    props.onChange(
      props.entries.map((current) =>
        current.id === editing.id ? { ...entry, enabled: editing.enabled } : current,
      ),
    );
    setEditing(null);
  };

  const exportDictionary = () => {
    const url = URL.createObjectURL(
      new Blob([serializeDictionary(props.entries)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "t3-voice-dictionary.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importDictionary = async (file: File) => {
    try {
      props.onChange(parseDictionaryImport(await file.text()));
      toastManager.add({ type: "success", title: "Dictionary imported." });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not import dictionary",
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {props.degraded ? (
        <Alert variant="warning">
          <AlertTitle>Dictionary editing is unavailable</AlertTitle>
          <AlertDescription>
            This server does not support voice dictionaries yet. Update the server to edit these
            entries.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <DictionaryFields draft={draft} onChange={setDraft} disabled={props.degraded} />
        <Button
          type="button"
          size="sm"
          onClick={addEntry}
          disabled={props.degraded}
          className="sm:self-start"
        >
          <PlusIcon data-icon="inline-start" />
          Add
        </Button>
      </div>
      {props.entries.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Spoken forms</TableHead>
              <TableHead>Replacement</TableHead>
              <TableHead>Fuzzy</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="max-w-64 truncate">{entry.originals.join(", ")}</TableCell>
                <TableCell>{entry.replacement ?? "Term only"}</TableCell>
                <TableCell>
                  <Switch
                    checked={entry.fuzzy}
                    disabled={props.degraded}
                    aria-label={`Fuzzy match ${entry.originals[0] ?? "entry"}`}
                    onCheckedChange={(checked) =>
                      props.onChange(
                        props.entries.map((current) =>
                          current.id === entry.id ? { ...current, fuzzy: checked } : current,
                        ),
                      )
                    }
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={entry.enabled}
                    disabled={props.degraded}
                    aria-label={`Enable ${entry.originals[0] ?? "entry"}`}
                    onCheckedChange={(checked) =>
                      props.onChange(
                        props.entries.map((current) =>
                          current.id === entry.id ? { ...current, enabled: checked } : current,
                        ),
                      )
                    }
                  />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${entry.originals[0] ?? "entry"}`}
                      disabled={props.degraded}
                      onClick={() => openEdit(entry)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${entry.originals[0] ?? "entry"}`}
                      disabled={props.degraded}
                      onClick={() =>
                        props.onChange(props.entries.filter((current) => current.id !== entry.id))
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-muted-foreground text-sm">
          No entries yet. Add aliases for names, products, or phrases the recognizer often misses.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void importDictionary(file);
            event.currentTarget.value = "";
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.degraded}
          onClick={() => importRef.current?.click()}
        >
          <UploadIcon data-icon="inline-start" />
          Import JSON
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={exportDictionary}
          disabled={props.entries.length === 0}
        >
          <DownloadIcon data-icon="inline-start" />
          Export JSON
        </Button>
      </div>

      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Edit dictionary entry</SheetTitle>
            <SheetDescription>
              Spoken forms are matched longest-first after a transcription segment is finalized.
            </SheetDescription>
          </SheetHeader>
          <SheetPanel>
            <DictionaryFields draft={editDraft} onChange={setEditDraft} disabled={false} />
          </SheetPanel>
          <SheetFooter>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={saveEdit}>
              Save
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

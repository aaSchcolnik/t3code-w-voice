import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  BookOpenIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderXIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { KnowledgeTable, ProjectId, SkillToggleProviderId } from "@t3tools/contracts";
import { SKILL_TOGGLE_CAPABILITIES, SKILL_TOGGLE_PROVIDER_IDS } from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer } from "./settingsLayout";
import { KnowledgeScanAgentSettings } from "./KnowledgeScanAgentSettings";
import {
  resolveSkillToggleState,
  setProviderSkillsDisabled,
  setSkillEnabled,
} from "./skillToggleLogic";

type KnowledgeRecord = Record<string, unknown>;
type KnowledgeTab =
  | "profile"
  | "reusable_components"
  | "lessons_learned"
  | "rules"
  | "audit_rules"
  | "features"
  | "skills"
  | "artifacts";
const tabs: ReadonlyArray<{ value: KnowledgeTab; label: string }> = [
  { value: "profile", label: "Profile" },
  { value: "reusable_components", label: "Components" },
  { value: "lessons_learned", label: "Lessons" },
  { value: "rules", label: "Rules" },
  { value: "audit_rules", label: "Audit rules" },
  { value: "features", label: "Features" },
  { value: "skills", label: "Skills" },
  { value: "artifacts", label: "Artifacts" },
];
const skillProviderLabels: Record<SkillToggleProviderId, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};
const skillProviderLimitations: Partial<Record<SkillToggleProviderId, string>> = {
  cursor: "Cursor CLI has no way to disable skills per session.",
  grok: "Grok only supports a global toggle that affects sessions outside T3 Code.",
};
const skillSourceLabels = {
  claude: "Claude",
  agents: "Agents",
  cursor: "Cursor",
  codex: "Codex",
} as const;
const profileFields = [
  { key: "framework", label: "Framework" },
  { key: "language", label: "Language" },
  { key: "package_manager", label: "Package manager" },
  { key: "test_runner", label: "Test runner" },
  { key: "default_branch", label: "Default branch" },
] as const;

const recordId = (row: KnowledgeRecord): string | number | null =>
  typeof row.id === "number" || typeof row.id === "string"
    ? row.id
    : typeof row.key === "string"
      ? row.key
      : null;
const recordTitle = (row: KnowledgeRecord): string => {
  for (const key of ["name", "title", "rule_id", "key", "concern", "framework"]) {
    if (typeof row[key] === "string" && row[key].trim()) return row[key];
  }
  return `Record ${String(recordId(row) ?? "")}`;
};
const recordSummary = (row: KnowledgeRecord): string => {
  for (const key of ["summary", "description", "rule_text", "body", "notes", "import_path"]) {
    if (typeof row[key] === "string" && row[key].trim()) return row[key];
  }
  return "No summary provided.";
};

function ProfileEditor({
  environmentId,
  projectId,
  profile,
  onSaved,
}: {
  environmentId: Parameters<
    typeof serverEnvironment.knowledgeUpdateProfile.run
  >[1]["environmentId"];
  projectId: ProjectId;
  profile: KnowledgeRecord | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(() => ({
    framework: typeof profile?.framework === "string" ? profile.framework : "",
    language: typeof profile?.language === "string" ? profile.language : "",
    package_manager: typeof profile?.package_manager === "string" ? profile.package_manager : "",
    test_runner: typeof profile?.test_runner === "string" ? profile.test_runner : "",
    default_branch: typeof profile?.default_branch === "string" ? profile.default_branch : "",
    notes: typeof profile?.notes === "string" ? profile.notes : "",
  }));
  const updateProfile = useAtomCommand(serverEnvironment.knowledgeUpdateProfile);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const result = await updateProfile({ environmentId, input: { projectId, profile: draft } });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Project profile</CardTitle>
        <CardDescription>
          Confirmed stack and repository conventions injected into every workflow.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <div className="grid gap-4 md:grid-cols-2">
            {profileFields.map(({ key, label }) => (
              <Field key={key}>
                <FieldLabel htmlFor={`profile-${key}`}>{label}</FieldLabel>
                <Input
                  id={`profile-${key}`}
                  value={draft[key]}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [key]: event.currentTarget.value }))
                  }
                />
              </Field>
            ))}
          </div>
          <Field>
            <FieldLabel htmlFor="profile-notes">Notes</FieldLabel>
            <Textarea
              id="profile-notes"
              value={draft.notes}
              onChange={(event) =>
                setDraft((current) => ({ ...current, notes: event.currentTarget.value }))
              }
            />
          </Field>
          <Button className="self-start" disabled={saving} onClick={save}>
            {saving ? <Spinner data-icon="inline-start" /> : null} Save confirmed profile
          </Button>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

function KnowledgeTableView({
  environmentId,
  projectId,
  table,
}: {
  environmentId: Parameters<typeof serverEnvironment.knowledgeSetStatus.run>[1]["environmentId"];
  projectId: ProjectId;
  table: KnowledgeTable;
}) {
  const [pendingOnly, setPendingOnly] = useState(true);
  const [selected, setSelected] = useState<ReadonlySet<string | number>>(new Set());
  const query = useEnvironmentQuery(
    serverEnvironment.knowledgeQuery({
      environmentId,
      input: {
        projectId,
        table,
        ...(pendingOnly ? { status: "proposed" as const } : {}),
        limit: 100,
      },
    }),
  );
  const setStatus = useAtomCommand(serverEnvironment.knowledgeSetStatus);
  const update = async (ids: ReadonlyArray<string | number>, status: "confirmed" | "rejected") => {
    const result = await setStatus({ environmentId, input: { projectId, table, ids, status } });
    if (result._tag === "Success") {
      setSelected(new Set());
      query.refresh();
    }
  };
  const rows = query.data?.rows ?? [];
  if (query.isPending && query.data === null)
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tabs.find((tab) => tab.value === table)?.label}</CardTitle>
        <CardDescription>
          {query.data?.total ?? 0} records. Proposed knowledge is never silently treated as
          confirmed.
        </CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Checkbox
            checked={pendingOnly}
            onCheckedChange={(checked) => setPendingOnly(Boolean(checked))}
            aria-label="Show pending proposals only"
          />
          <span className="text-sm text-muted-foreground">Pending review only</span>
          {selected.size > 0 ? (
            <>
              <Button size="xs" onClick={() => update([...selected], "confirmed")}>
                <CheckIcon data-icon="inline-start" />
                Confirm selected
              </Button>
              <Button size="xs" variant="outline" onClick={() => update([...selected], "rejected")}>
                <XIcon data-icon="inline-start" />
                Reject selected
              </Button>
            </>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {query.error ? <Alert>{query.error}</Alert> : null}
        {rows.length === 0 ? (
          <Empty>
            <EmptyMedia variant="icon">
              <BookOpenIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No matching knowledge</EmptyTitle>
              <EmptyDescription>
                Bootstrap the project or change the pending filter.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-40">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const id = recordId(row);
                if (id === null) return null;
                return (
                  <TableRow key={String(id)}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(id)}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(id);
                            else next.delete(id);
                            return next;
                          })
                        }
                        aria-label={`Select ${recordTitle(row)}`}
                      />
                    </TableCell>
                    <TableCell className="max-w-xl whitespace-normal">
                      <div className="font-medium">{recordTitle(row)}</div>
                      <div className="line-clamp-2 text-muted-foreground">{recordSummary(row)}</div>
                      {Array.isArray(row.agreed_by) && row.agreed_by.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {row.agreed_by.map((scanner) => (
                            <Badge key={String(scanner)} size="sm" variant="secondary">
                              {String(scanner)}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          row.status === "confirmed"
                            ? "success"
                            : row.status === "rejected"
                              ? "error"
                              : "warning"
                        }
                      >
                        {String(row.status ?? "proposed")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Confirm proposal"
                          onClick={() => update([id], "confirmed")}
                        >
                          <CheckIcon />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Reject proposal"
                          onClick={() => update([id], "rejected")}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SkillsView({
  environmentId,
  projectId,
  isActive,
}: {
  environmentId: Parameters<typeof serverEnvironment.knowledgeListSkills>[0]["environmentId"];
  projectId: ProjectId;
  isActive: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const skills = useEnvironmentQuery(
    isActive
      ? serverEnvironment.knowledgeListSkills({ environmentId, input: { projectId } })
      : null,
  );
  const scan = skills.data;
  const hasAgentInstructions = scan?.agentFiles.claudeMd || scan?.agentFiles.agentsMd;
  const persistSkills = (next: typeof settings.skills) => updateSettings({ skills: next });

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Skill availability</CardTitle>
            <CardDescription>
              Control which skills providers can use. Changes apply to new sessions only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field className="flex-row items-center justify-between">
                <FieldLabel htmlFor="skills-disable-all-providers">
                  Disable all skills for all providers
                </FieldLabel>
                <Switch
                  id="skills-disable-all-providers"
                  checked={settings.skills.disableAllProviders}
                  onCheckedChange={(checked) =>
                    persistSkills({
                      ...settings.skills,
                      disableAllProviders: Boolean(checked),
                    })
                  }
                />
              </Field>
              {SKILL_TOGGLE_PROVIDER_IDS.map((providerId) => {
                const capability = SKILL_TOGGLE_CAPABILITIES[providerId];
                const limitation = skillProviderLimitations[providerId];
                const isEnforceable = capability === "full";
                const control = (
                  <Switch
                    id={`skills-disable-all-${providerId}`}
                    checked={settings.skills.providers[providerId].disableAll}
                    disabled={!isEnforceable}
                    onCheckedChange={(checked) =>
                      persistSkills(
                        setProviderSkillsDisabled(settings.skills, providerId, Boolean(checked)),
                      )
                    }
                    aria-label={`Disable all ${skillProviderLabels[providerId]} skills`}
                  />
                );

                return (
                  <Field
                    key={providerId}
                    className="flex-row items-center justify-between"
                    data-disabled={!isEnforceable || undefined}
                  >
                    <FieldLabel htmlFor={`skills-disable-all-${providerId}`}>
                      Disable all for {skillProviderLabels[providerId]}
                    </FieldLabel>
                    {limitation ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
                        <TooltipPopup>{limitation}</TooltipPopup>
                      </Tooltip>
                    ) : (
                      control
                    )}
                  </Field>
                );
              })}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Project skills</CardTitle>
            <CardDescription>
              Skills are scanned from project and user provider directories each time you refresh
              this tab.
            </CardDescription>
            <CardAction>
              <Button
                size="sm"
                variant="outline"
                disabled={skills.isPending}
                onClick={skills.refresh}
              >
                {skills.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                Refresh
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {skills.isPending && scan === null ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-full max-w-lg" />
              </div>
            ) : skills.error ? (
              <Alert variant="error">
                <AlertTitle>Could not scan project skills</AlertTitle>
                <AlertDescription>{skills.error}</AlertDescription>
              </Alert>
            ) : scan?.scannedRoot === null ? (
              <Empty className="py-6 md:py-8">
                <EmptyMedia variant="icon">
                  <FolderXIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Project directory unavailable</EmptyTitle>
                  <EmptyDescription>
                    This project’s workspace directory no longer exists or cannot be read.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : scan ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Agent instructions</span>
                  {scan.agentFiles.claudeMd ? <Badge variant="secondary">CLAUDE.md</Badge> : null}
                  {scan.agentFiles.agentsMd ? <Badge variant="secondary">AGENTS.md</Badge> : null}
                  {!hasAgentInstructions ? (
                    <span className="text-muted-foreground">None detected</span>
                  ) : null}
                </div>
                <p className="font-mono text-muted-foreground text-xs">{scan.scannedRoot}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {scan !== null && scan.scannedRoot !== null && scan.skills.length === 0 ? (
          <Empty>
            <EmptyMedia variant="icon">
              <FileTextIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No project skills found</EmptyTitle>
              <EmptyDescription>
                Add a SKILL.md under a supported project or user skills directory to make it
                available here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {scan?.skills.map((skill) => (
          <Card key={skill.skillId}>
            <CardHeader>
              <CardTitle>{skill.name}</CardTitle>
              <CardDescription>{skill.description || "No description provided."}</CardDescription>
              <CardAction>
                <div className="flex flex-wrap justify-end gap-1">
                  {skill.locations.map((location) => (
                    <Badge key={`${location.scope}:${location.path}`} variant="outline">
                      {skillSourceLabels[location.source]} · {location.scope}
                    </Badge>
                  ))}
                </div>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <FieldGroup>
                  {SKILL_TOGGLE_PROVIDER_IDS.filter(
                    (providerId) => SKILL_TOGGLE_CAPABILITIES[providerId] === "full",
                  ).map((providerId) => {
                    const toggleState = resolveSkillToggleState(
                      settings.skills,
                      providerId,
                      skill.skillId,
                    );
                    const overrideMessage =
                      toggleState.overriddenBy === "master"
                        ? "Disabled by the master switch"
                        : toggleState.overriddenBy === "provider"
                          ? `Disabled for all ${skillProviderLabels[providerId]} skills`
                          : null;
                    const switchId = `skill-${providerId}-${skill.skillId}`;
                    return (
                      <Field
                        key={providerId}
                        className="flex-row flex-wrap items-center justify-between"
                        data-disabled={toggleState.overriddenBy !== null || undefined}
                      >
                        <FieldLabel htmlFor={switchId}>
                          {skillProviderLabels[providerId]}
                        </FieldLabel>
                        <Switch
                          id={switchId}
                          checked={toggleState.enabled}
                          disabled={toggleState.overriddenBy !== null}
                          onCheckedChange={(checked) =>
                            persistSkills(
                              setSkillEnabled(
                                settings.skills,
                                providerId,
                                skill.skillId,
                                Boolean(checked),
                              ),
                            )
                          }
                          aria-label={`Enable ${skill.name} for ${skillProviderLabels[providerId]}`}
                        />
                        {overrideMessage ? (
                          <FieldDescription className="basis-full">
                            {overrideMessage}
                          </FieldDescription>
                        ) : null}
                      </Field>
                    );
                  })}
                </FieldGroup>
                <span className="font-medium text-[0.6875rem] uppercase tracking-wide text-muted-foreground/70">
                  Locations
                </span>
                <div className="flex flex-col gap-1">
                  {skill.locations.map((location) => (
                    <p
                      key={location.path}
                      className="font-mono text-[0.6875rem] leading-relaxed text-muted-foreground/70"
                    >
                      {location.path}
                    </p>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </TooltipProvider>
  );
}

function ArtifactsView({
  environmentId,
  projectId,
}: {
  environmentId: Parameters<typeof serverEnvironment.knowledgeDeleteCase.run>[1]["environmentId"];
  projectId: ProjectId;
}) {
  const [caseSlug, setCaseSlug] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<number | null>(null);
  const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
  const cases = useEnvironmentQuery(
    serverEnvironment.knowledgeListCases({ environmentId, input: { projectId } }),
  );
  const artifacts = useEnvironmentQuery(
    caseSlug
      ? serverEnvironment.knowledgeListArtifacts({ environmentId, input: { projectId, caseSlug } })
      : null,
  );
  const artifact = useEnvironmentQuery(
    artifactId === null
      ? null
      : serverEnvironment.knowledgeGetArtifact({
          environmentId,
          input: { projectId, id: artifactId },
        }),
  );
  const deleteCaseCommand = useAtomCommand(serverEnvironment.knowledgeDeleteCase);
  const confirmDelete = async () => {
    if (!deleteSlug) return;
    const result = await deleteCaseCommand({
      environmentId,
      input: { projectId, caseSlug: deleteSlug },
    });
    if (result._tag === "Success") {
      if (caseSlug === deleteSlug) setCaseSlug(null);
      setDeleteSlug(null);
      cases.refresh();
    }
  };
  const openHtml = () => {
    if (typeof artifact.data?.content !== "string") return;
    const url = URL.createObjectURL(new Blob([artifact.data.content], { type: "text/html" }));
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Implementation cases</CardTitle>
          <CardDescription>Opening an artifact resets its 21-day retention clock.</CardDescription>
        </CardHeader>
        <CardContent>
          {(cases.data ?? []).length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No artifacts yet</EmptyTitle>
                <EmptyDescription>Engine plans and reports will appear here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {(cases.data ?? []).map((entry) => {
                const slug = String(entry.case_slug ?? "");
                return (
                  <div key={slug} className="flex items-center gap-2 rounded-lg border p-3">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        setCaseSlug(slug);
                        setArtifactId(null);
                      }}
                    >
                      <div className="truncate font-medium">{String(entry.title ?? slug)}</div>
                      <div className="text-xs text-muted-foreground">
                        {String(entry.kind)} · expires in {String(entry.expires_in_days ?? 21)} days
                      </div>
                    </button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${slug}`}
                      onClick={() => setDeleteSlug(slug)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{caseSlug ?? "Artifact preview"}</CardTitle>
          <CardDescription>Select a case, then an artifact to inspect it.</CardDescription>
        </CardHeader>
        <CardContent>
          {caseSlug ? (
            <div className="flex flex-wrap gap-2 pb-4">
              {(artifacts.data ?? []).map((entry) => (
                <Button
                  key={String(entry.id)}
                  size="xs"
                  variant={artifactId === entry.id ? "default" : "outline"}
                  onClick={() => setArtifactId(Number(entry.id))}
                >
                  {String(entry.kind)} #{String(entry.seq)}
                </Button>
              ))}
            </div>
          ) : null}
          {artifact.isPending ? (
            <Spinner />
          ) : artifact.data ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <Badge variant="outline">{String(artifact.data.format)}</Badge>
                {artifact.data.format === "html" ? (
                  <Button size="xs" variant="outline" onClick={openHtml}>
                    <ExternalLinkIcon data-icon="inline-start" />
                    Open HTML
                  </Button>
                ) : null}
              </div>
              {artifact.data.format === "markdown" && typeof artifact.data.content === "string" ? (
                <article className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown>{artifact.data.content}</ReactMarkdown>
                </article>
              ) : artifact.data.format === "html" && typeof artifact.data.content === "string" ? (
                <iframe
                  title={String(artifact.data.title ?? "HTML report")}
                  className="min-h-96 w-full rounded-lg border bg-background"
                  sandbox="allow-scripts"
                  srcDoc={artifact.data.content}
                />
              ) : (
                <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-xs">
                  {String(artifact.data.content ?? "")}
                </pre>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
      <AlertDialog
        open={deleteSlug !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteSlug(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete implementation case?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the case and every artifact it contains. Project knowledge is
              not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete case
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export function KnowledgeSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const projects = useEnvironmentQuery(
    environmentId ? serverEnvironment.knowledgeListProjects({ environmentId, input: {} }) : null,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [tab, setTab] = useState<KnowledgeTab>("profile");
  const projectId = selectedProjectId ?? projects.data?.[0]?.projectId ?? null;
  const projectOptions = useMemo(
    () =>
      (projects.data ?? []).map((project) => ({
        value: project.projectId,
        label: `${project.title}${project.pendingCount > 0 ? ` · ${project.pendingCount} pending` : ""}`,
      })),
    [projects.data],
  );
  const profile = useEnvironmentQuery(
    environmentId && projectId
      ? serverEnvironment.knowledgeGetProfile({ environmentId, input: { projectId } })
      : null,
  );
  const scanAvailability = useEnvironmentQuery(
    environmentId && projectId
      ? serverEnvironment.knowledgeScanAvailability({ environmentId, input: { projectId } })
      : null,
  );
  const profileKey = useMemo(
    () => `${projectId ?? "none"}-${String(profile.data?.updated_at ?? "new")}`,
    [profile.data?.updated_at, projectId],
  );
  return (
    <SettingsPageContainer>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Project Knowledge</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review the evidence agents use and inspect expiring implementation artifacts.
        </p>
      </div>
      <KnowledgeScanAgentSettings />
      {environmentId === null ? (
        <Alert>No server environment is selected.</Alert>
      ) : projects.isPending && projects.data === null ? (
        <div className="flex justify-center p-10">
          <Spinner />
        </div>
      ) : (projects.data ?? []).length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <BookOpenIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No projects available</EmptyTitle>
            <EmptyDescription>
              Add a project before bootstrapping Implementation Engine knowledge.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Field>
            <FieldLabel>Project</FieldLabel>
            <Select
              items={projectOptions}
              value={projectId ?? undefined}
              onValueChange={(value) => value && setSelectedProjectId(value as ProjectId)}
            >
              <SelectTrigger className="max-w-md">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectPopup>
                <SelectGroup>
                  {projectOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          </Field>
          {projectId ? (
            <>
              {scanAvailability.data?.lastScanAt ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Last codebase scan</CardTitle>
                    <CardDescription>
                      {new Date(scanAvailability.data.lastScanAt).toLocaleString()} ·{" "}
                      {scanAvailability.data.lastScanReportCount ?? 0} scanner reports merged
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button variant="outline" onClick={() => setTab("artifacts")}>
                      <ExternalLinkIcon data-icon="inline-start" />
                      View scan artifacts
                    </Button>
                  </CardContent>
                </Card>
              ) : null}
              <Tabs value={tab} onValueChange={(value) => setTab(value as KnowledgeTab)}>
                <TabsList
                  variant="line"
                  className="max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {tabs.map((item) => (
                    <TabsTrigger key={item.value} value={item.value}>
                      {item.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value="profile">
                  {environmentId ? (
                    <ProfileEditor
                      key={profileKey}
                      environmentId={environmentId}
                      projectId={projectId}
                      profile={profile.data}
                      onSaved={profile.refresh}
                    />
                  ) : null}
                </TabsContent>
                {tabs
                  .filter((item) => !["profile", "skills", "artifacts"].includes(item.value))
                  .map((item) => (
                    <TabsContent key={item.value} value={item.value}>
                      <KnowledgeTableView
                        environmentId={environmentId}
                        projectId={projectId}
                        table={item.value as KnowledgeTable}
                      />
                    </TabsContent>
                  ))}
                <TabsContent value="skills">
                  <SkillsView
                    environmentId={environmentId}
                    projectId={projectId}
                    isActive={tab === "skills"}
                  />
                </TabsContent>
                <TabsContent value="artifacts">
                  <ArtifactsView environmentId={environmentId} projectId={projectId} />
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </>
      )}
    </SettingsPageContainer>
  );
}

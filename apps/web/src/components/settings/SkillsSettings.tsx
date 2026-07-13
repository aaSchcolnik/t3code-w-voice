import { useAtomValue } from "@effect/atom-react";
import {
  resolveDelegationRoles,
  type EngineDelegationRole,
  type EngineDelegationSkillOverride,
  type ProjectId,
  type ProjectMcpOverrides,
  type SkillDetail,
  type SkillSummary,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
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
import { Skeleton } from "../ui/skeleton";
import { Separator } from "../ui/separator";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChainEditor } from "./EngineDelegationSettings";
import { McpBooleanControl } from "./McpSettings";
import { ImportSkillsDialog } from "./ImportSkillsDialog";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  hasMissingBuiltinSkills,
  orderSkillVersions,
  partitionSkillsByProject,
  skillDelegationRoles,
} from "./skillsLogic";

const roleLabels: Record<EngineDelegationRole, { title: string; description: string }> = {
  scout: {
    title: "Scout chain",
    description: "Ordered fallbacks for search, evidence gathering, and rule checks.",
  },
  worker: {
    title: "Worker chain",
    description: "Ordered fallbacks for bounded implementation chunks with disjoint files.",
  },
  consensus: {
    title: "Consensus panel",
    description: "Every available member runs in parallel on consensus tasks.",
  },
  scanner: {
    title: "Scanner panel",
    description: "Parallel full-codebase scan lanes, including the Judge's inline pass.",
  },
};
const sourceLabels: Record<SkillSummary["source"], string> = {
  builtin: "Built-in",
  user: "Custom",
  agent: "Agent-created",
};

function IconAction({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={label} onClick={onClick}>
            {children}
          </Button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function SkillEditor({
  detail,
  open,
  onOpenChange,
  onSaved,
}: {
  detail: SkillDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const environmentId = usePrimaryEnvironment()!.environmentId;
  const saveVersion = useAtomCommand(serverEnvironment.skillsSaveVersion);
  const updateMeta = useAtomCommand(serverEnvironment.skillsUpdateMeta);
  const [title, setTitle] = useState(detail.skill.title);
  const [description, setDescription] = useState(detail.skill.description);
  const [content, setContent] = useState(detail.activeVersion.content);
  const [changeNote, setChangeNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    setTitle(detail.skill.title);
    setDescription(detail.skill.description);
    setContent(detail.activeVersion.content);
    setChangeNote("");
    setSaveMessage(null);
  }, [detail]);

  const save = async () => {
    setSaving(true);
    setSaveMessage(null);
    const versionResult = await saveVersion({
      environmentId,
      input: {
        skillId: detail.skill.skillId,
        content,
        ...(changeNote.trim() === "" ? {} : { changeNote: changeNote.trim() }),
      },
    });
    const metaResult = await updateMeta({
      environmentId,
      input: { skillId: detail.skill.skillId, title, description },
    });
    setSaving(false);
    if (versionResult._tag === "Success" && metaResult._tag === "Success") {
      setSaveMessage(versionResult.value.created ? "New version saved." : "No version changes.");
      onSaved();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-6xl">
        <DialogHeader>
          <DialogTitle>Edit {detail.skill.title}</DialogTitle>
          <DialogDescription>
            Saving prompt or agent-flow changes creates an immutable new version.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <FieldGroup>
            <div className="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`skill-title-${detail.skill.skillId}`}>Title</FieldLabel>
                <Input
                  id={`skill-title-${detail.skill.skillId}`}
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`skill-description-${detail.skill.skillId}`}>
                  Description
                </FieldLabel>
                <Input
                  id={`skill-description-${detail.skill.skillId}`}
                  value={description}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </Field>
            </div>
            <div className="grid min-h-96 gap-4 lg:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`skill-content-${detail.skill.skillId}`}>Markdown</FieldLabel>
                <Textarea
                  id={`skill-content-${detail.skill.skillId}`}
                  className="min-h-96 resize-y font-mono text-xs"
                  value={content}
                  onChange={(event) => setContent(event.currentTarget.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Preview</FieldLabel>
                <div className="min-h-96 overflow-auto rounded-xl border bg-background p-4">
                  <ChatMarkdown text={content} cwd={undefined} />
                </div>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor={`skill-note-${detail.skill.skillId}`}>Change note</FieldLabel>
              <Input
                id={`skill-note-${detail.skill.skillId}`}
                placeholder="Optional summary of this version"
                value={changeNote}
                onChange={(event) => setChangeNote(event.currentTarget.value)}
              />
            </Field>
            {saveMessage ? <p className="text-sm text-muted-foreground">{saveMessage}</p> : null}
          </FieldGroup>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={saving || title.trim() === ""} onClick={() => void save()}>
            {saving ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SkillCard({
  skill,
  environmentId,
  onChanged,
}: {
  skill: SkillSummary;
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironment>>["environmentId"];
  onChanged: () => void;
}) {
  const settings = usePrimarySettings();
  const providerEntries = deriveProviderInstanceEntries(useAtomValue(primaryServerProvidersAtom));
  const inheritedRoles = resolveDelegationRoles(
    settings.mcp.engine.delegation,
    new Set(["codex", "cursor", "inline"] as const),
  );
  const detail = useEnvironmentQuery(
    serverEnvironment.skillsGet({ environmentId, input: { skillId: skill.skillId } }),
  );
  const setVersion = useAtomCommand(serverEnvironment.skillsSetActiveVersion);
  const saveVersion = useAtomCommand(serverEnvironment.skillsSaveVersion);
  const updateMeta = useAtomCommand(serverEnvironment.skillsUpdateMeta);
  const deleteSkill = useAtomCommand(serverEnvironment.skillsDelete);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [delegation, setDelegation] = useState<EngineDelegationSkillOverride>({});
  const [delegationDirty, setDelegationDirty] = useState(false);
  const [savingDelegation, setSavingDelegation] = useState(false);
  const versions = useMemo(
    () => orderSkillVersions(detail.data?.versions ?? []),
    [detail.data?.versions],
  );
  const delegatedRoles = useMemo(
    () => skillDelegationRoles(detail.data?.activeVersion.content ?? ""),
    [detail.data?.activeVersion.content],
  );
  useEffect(() => {
    setDelegation(detail.data?.activeVersion.delegation ?? {});
    setDelegationDirty(false);
  }, [detail.data?.activeVersion]);
  const refresh = () => {
    detail.refresh();
    onChanged();
  };
  const updateDelegationRole = (
    role: EngineDelegationRole,
    chain: EngineDelegationSkillOverride[EngineDelegationRole],
  ) => {
    setDelegation((current) => ({ ...current, [role]: chain }));
    setDelegationDirty(true);
  };
  const restoreDelegationRole = (role: EngineDelegationRole) => {
    setDelegation((current) => {
      const next = { ...current };
      delete next[role];
      return next;
    });
    setDelegationDirty(true);
  };
  const saveDelegation = async () => {
    if (!detail.data || !delegationDirty) return;
    setSavingDelegation(true);
    const result = await saveVersion({
      environmentId,
      input: {
        skillId: skill.skillId,
        content: detail.data.activeVersion.content,
        delegation: Object.keys(delegation).length === 0 ? null : delegation,
        changeNote: "Updated subagent delegation",
      },
    });
    setSavingDelegation(false);
    if (result._tag === "Success") refresh();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>{skill.title}</CardTitle>
          <Badge variant="secondary">{sourceLabels[skill.source]}</Badge>
        </div>
        <CardDescription>{skill.description || "No description."}</CardDescription>
        <CardAction className="items-center gap-1">
          <span className="mr-1 text-xs font-medium text-muted-foreground">Version:</span>
          <Select
            value={String(skill.activeVersion)}
            onValueChange={(value) => {
              if (value === null) return;
              void setVersion({
                environmentId,
                input: { skillId: skill.skillId, version: Number(value) },
              }).then(refresh);
            }}
          >
            <SelectTrigger className="w-16" size="xs" aria-label={`Version for ${skill.title}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectGroup>
                {versions.map((version) => (
                  <SelectItem key={version.version} value={String(version.version)}>
                    {version.version}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
          <IconAction label="Edit" onClick={() => setEditing(true)}>
            <PencilIcon />
          </IconAction>
          <IconAction label="Delete" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon />
          </IconAction>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Field className="flex-row items-center">
          <div className="flex-1">
            <FieldLabel htmlFor={`skill-enabled-${skill.skillId}`}>Enabled</FieldLabel>
            <FieldDescription>
              Disabled skills remain stored but cannot be run by engine tools.
            </FieldDescription>
          </div>
          <Switch
            id={`skill-enabled-${skill.skillId}`}
            checked={skill.enabled}
            onCheckedChange={(checked) =>
              void updateMeta({
                environmentId,
                input: { skillId: skill.skillId, enabled: Boolean(checked) },
              }).then(onChanged)
            }
          />
        </Field>
        {delegatedRoles.length > 0 && detail.data ? (
          <>
            <Separator className="my-4" />
            <Collapsible open={delegationOpen} onOpenChange={setDelegationOpen}>
              <CollapsibleTrigger
                render={
                  <Button
                    className="w-full justify-start"
                    variant="ghost"
                    aria-label={`${delegationOpen ? "Collapse" : "Expand"} ${skill.title} subagent delegation`}
                  />
                }
              >
                {delegationOpen ? (
                  <ChevronDownIcon data-icon="inline-start" />
                ) : (
                  <ChevronRightIcon data-icon="inline-start" />
                )}
                <span className="flex-1 text-left">Subagent delegation</span>
                <Badge variant="secondary">
                  {detail.data.activeVersion.delegation === null
                    ? "Inherited defaults"
                    : `Saved in version ${detail.data.activeVersion.version}`}
                </Badge>
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <FieldGroup className="pt-4">
                  <p className="text-xs text-muted-foreground">
                    These provider, model, and reasoning choices are saved with the skill version.
                  </p>
                  {delegatedRoles.map((role) => (
                    <Field key={role}>
                      <div className="flex w-full items-start justify-between gap-3">
                        <div>
                          <FieldLabel>{roleLabels[role].title}</FieldLabel>
                          <FieldDescription>{roleLabels[role].description}</FieldDescription>
                        </div>
                        {delegation[role] === undefined ? null : (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => restoreDelegationRole(role)}
                          >
                            Use default
                          </Button>
                        )}
                      </div>
                      <ChainEditor
                        role={role}
                        chain={delegation[role] ?? inheritedRoles[role]}
                        providerEntries={providerEntries}
                        onChange={(chain) => updateDelegationRole(role, chain)}
                      />
                    </Field>
                  ))}
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={!delegationDirty || savingDelegation}
                      onClick={() => void saveDelegation()}
                    >
                      {savingDelegation ? <Spinner data-icon="inline-start" /> : null}
                      Save as new version
                    </Button>
                  </div>
                </FieldGroup>
              </CollapsiblePanel>
            </Collapsible>
          </>
        ) : null}
      </CardContent>
      {detail.data ? (
        <SkillEditor
          detail={detail.data}
          open={editing}
          onOpenChange={setEditing}
          onSaved={refresh}
        />
      ) : null}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {skill.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes every version. Deleted built-ins can be restored later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() =>
                void deleteSkill({ environmentId, input: { skillId: skill.skillId } }).then(() => {
                  setConfirmDelete(false);
                  onChanged();
                })
              }
            >
              Delete skill
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Card>
  );
}

function NewSkillDialog({
  open,
  onOpenChange,
  onCreated,
  environmentId,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironment>>["environmentId"];
  projectId?: ProjectId | undefined;
}) {
  const createSkill = useAtomCommand(serverEnvironment.skillsCreate);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const normalizedSlug = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const create = async () => {
    setSaving(true);
    const result = await createSkill({
      environmentId,
      input: {
        slug: normalizedSlug,
        title: title.trim(),
        description: "",
        content: `# ${title.trim()}\n\n## Instructions\n\nDescribe what this skill should do.\n\n## Delegation guidance\n\n- **Judge:** Own the final result on the main thread.`,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setSlug("");
      setTitle("");
      onOpenChange(false);
      onCreated();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            Create a {projectId === undefined ? "globally available" : "project-owned"}, versioned
            engine skill.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-skill-title">Title</FieldLabel>
              <Input
                id="new-skill-title"
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-skill-slug">Slug</FieldLabel>
              <Input
                id="new-skill-slug"
                value={slug}
                onChange={(event) => setSlug(event.currentTarget.value)}
                placeholder="release-readiness"
              />
              <FieldDescription>Lowercase letters, numbers, and hyphens.</FieldDescription>
            </Field>
          </FieldGroup>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={saving || title.trim() === "" || normalizedSlug === ""}
            onClick={() => void create()}
          >
            {saving ? <Spinner data-icon="inline-start" /> : null}
            Create skill
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SkillsScopeField({
  scopeItems,
  scope,
  onScopeChange,
  resetAction,
}: {
  scopeItems: ReadonlyArray<{ value: string; label: string }>;
  scope: string;
  onScopeChange: (scope: string) => void;
  resetAction?: React.ReactNode;
}) {
  return (
    <Field>
      <FieldLabel>Settings scope</FieldLabel>
      <FieldDescription>
        Projects inherit the global skill catalog and can enable or disable global skills. Skills
        owned by the selected project can be created, edited, versioned, and deleted there. Title
        and description changes are advertised to agents when the next thread starts.
      </FieldDescription>
      <div className="flex items-center gap-2">
        <Select
          items={[...scopeItems]}
          value={scope}
          onValueChange={(value) => value && onScopeChange(value)}
        >
          <SelectTrigger className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectGroup>
              {scopeItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectPopup>
        </Select>
        {resetAction}
      </div>
    </Field>
  );
}

export function SkillsSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const projects = useProjects();
  const [scope, setScope] = useState("global");
  const selectedProject = projects.find(
    (project) => `${project.environmentId}:${project.id}` === scope,
  );
  const queryEnvironmentId = selectedProject?.environmentId ?? environmentId;
  const skills = useEnvironmentQuery(
    queryEnvironmentId
      ? serverEnvironment.skillsList({
          environmentId: queryEnvironmentId,
          input: selectedProject === undefined ? {} : { projectId: selectedProject.id },
        })
      : null,
  );
  const restoreDefaults = useAtomCommand(serverEnvironment.skillsRestoreDefaults);
  const updateProjectMcp = useAtomCommand(projectEnvironment.updateMcpSettings);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const records = skills.data ?? [];
  const scopedRecords =
    selectedProject === undefined
      ? { projectSkills: [], globalSkills: records }
      : partitionSkillsByProject(records, selectedProject.id);
  const missingBuiltins = hasMissingBuiltinSkills(scopedRecords.globalSkills);
  const projectOverrides = selectedProject?.mcpOverrides ?? undefined;
  const scopeItems = [
    { value: "global", label: "Global defaults" },
    ...projects.map((project) => ({
      value: `${project.environmentId}:${project.id}`,
      label: project.title,
    })),
  ];
  const persistProjectOverrides = (next: ProjectMcpOverrides) => {
    if (selectedProject === undefined) return;
    void updateProjectMcp({
      environmentId: selectedProject.environmentId,
      input: { projectId: selectedProject.id, mcpOverrides: next },
    });
  };
  const updateProjectSkill = (skillId: string, value: boolean | undefined) => {
    const nextSkills: Record<string, boolean> = { ...projectOverrides?.skills };
    if (value === undefined) delete nextSkills[skillId];
    else nextSkills[skillId] = value;
    const next: Record<string, unknown> = { ...projectOverrides };
    if (Object.keys(nextSkills).length === 0) delete next.skills;
    else next.skills = nextSkills;
    persistProjectOverrides(next as ProjectMcpOverrides);
  };
  const resetProjectSkills = () => {
    const next: Record<string, unknown> = { ...projectOverrides };
    delete next.skills;
    persistProjectOverrides(next as ProjectMcpOverrides);
  };

  if (selectedProject !== undefined) {
    return (
      <SettingsPageContainer>
        <SkillsScopeField
          scopeItems={scopeItems}
          scope={scope}
          onScopeChange={setScope}
          resetAction={
            projectOverrides?.skills === undefined ? null : (
              <Button variant="outline" onClick={resetProjectSkills}>
                Reset all to global
              </Button>
            )
          }
        />
        <SettingsSection
          title="Project skills"
          headerAction={
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
                <DownloadIcon data-icon="inline-start" />
                Import
              </Button>
              <IconAction label="New project skill" onClick={() => setCreating(true)}>
                <PlusIcon />
              </IconAction>
            </div>
          }
        >
          <div className="flex flex-col gap-3 p-3 sm:p-4">
            {skills.isPending && skills.data === null ? (
              <Skeleton className="h-28 rounded-2xl" />
            ) : scopedRecords.projectSkills.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SparklesIcon />
                  </EmptyMedia>
                  <EmptyTitle>No project skills</EmptyTitle>
                  <EmptyDescription>
                    Create a skill available only to {selectedProject.title}.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              scopedRecords.projectSkills.map((skill) => (
                <SkillCard
                  key={skill.skillId}
                  skill={skill}
                  environmentId={selectedProject.environmentId}
                  onChanged={skills.refresh}
                />
              ))
            )}
          </div>
        </SettingsSection>
        <SettingsSection title="Global skills">
          {scopedRecords.globalSkills.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SparklesIcon />
                </EmptyMedia>
                <EmptyTitle>No global skills</EmptyTitle>
                <EmptyDescription>Create global skills from the global scope.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            scopedRecords.globalSkills.map((skill) => (
              <SettingsRow
                key={skill.skillId}
                title={
                  <span className="inline-flex items-center gap-2">
                    {skill.title}
                    <Badge variant="secondary">{sourceLabels[skill.source]}</Badge>
                  </span>
                }
                description={skill.description || "No description."}
                status={
                  skill.enabled
                    ? undefined
                    : "Disabled globally — this project setting takes effect once the skill is enabled in the global scope."
                }
                control={
                  <McpBooleanControl
                    projectScoped
                    globalValue={skill.enabled}
                    projectValue={projectOverrides?.skills?.[skill.skillId]}
                    label={`Enable ${skill.title} for ${selectedProject.title}`}
                    onGlobalChange={() => {}}
                    onProjectChange={(value) => updateProjectSkill(skill.skillId, value)}
                  />
                }
              />
            ))
          )}
        </SettingsSection>
        <NewSkillDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={skills.refresh}
          environmentId={selectedProject.environmentId}
          projectId={selectedProject.id}
        />
        <ImportSkillsDialog
          open={importing}
          onOpenChange={setImporting}
          target="project"
          projects={projects}
          project={selectedProject}
          onImported={skills.refresh}
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SkillsScopeField scopeItems={scopeItems} scope={scope} onScopeChange={setScope} />
      <SettingsSection
        title="Skills"
        headerAction={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
              <DownloadIcon data-icon="inline-start" />
              Import
            </Button>
            <IconAction label="New skill" onClick={() => setCreating(true)}>
              <PlusIcon />
            </IconAction>
          </div>
        }
      >
        <div className="flex flex-col gap-3 p-3 sm:p-4">
          {skills.isPending && skills.data === null ? (
            <>
              <Skeleton className="h-28 rounded-2xl" />
              <Skeleton className="h-28 rounded-2xl" />
            </>
          ) : records.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SparklesIcon />
                </EmptyMedia>
                <EmptyTitle>No skills</EmptyTitle>
                <EmptyDescription>
                  Create a custom skill or restore the built-in workflows.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            records.map((skill) => (
              <SkillCard
                key={skill.skillId}
                skill={skill}
                environmentId={environmentId!}
                onChanged={skills.refresh}
              />
            ))
          )}
          {missingBuiltins && environmentId ? (
            <Button
              className="self-start"
              variant="ghost"
              onClick={() =>
                void restoreDefaults({ environmentId, input: {} }).then(skills.refresh)
              }
            >
              <RotateCcwIcon data-icon="inline-start" />
              Restore default skills
            </Button>
          ) : null}
        </div>
      </SettingsSection>
      {environmentId ? (
        <>
          <NewSkillDialog
            open={creating}
            onOpenChange={setCreating}
            onCreated={skills.refresh}
            environmentId={environmentId}
          />
          <ImportSkillsDialog
            open={importing}
            onOpenChange={setImporting}
            target="global"
            projects={projects.filter((project) => project.environmentId === environmentId)}
            onImported={skills.refresh}
          />
        </>
      ) : null}
    </SettingsPageContainer>
  );
}

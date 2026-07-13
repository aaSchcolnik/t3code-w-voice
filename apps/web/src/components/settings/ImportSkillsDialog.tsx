import type {
  EnvironmentId,
  ProjectId,
  SkillImportItemResult,
  SkillImportTarget,
} from "@t3tools/contracts";
import { AlertCircleIcon, FolderSearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { ScrollArea } from "../ui/scroll-area";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import {
  indexSkillImportResults,
  initialSkillImportSelection,
  skillImportOutcomeLabel,
  toggleSkillImportSelection,
} from "./importSkillsLogic";

export interface SkillImportProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

const outcomeVariant = (
  outcome: SkillImportItemResult["outcome"],
): "success" | "secondary" | "warning" | "error" => {
  if (outcome === "created" || outcome === "new_version") return "success";
  if (outcome === "unchanged") return "secondary";
  if (outcome === "missing") return "warning";
  return "error";
};

export function ImportSkillsDialog({
  open,
  onOpenChange,
  target,
  projects,
  project,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: SkillImportTarget;
  projects: ReadonlyArray<SkillImportProject>;
  project?: SkillImportProject | undefined;
  onImported: () => void;
}) {
  const importSkills = useAtomCommand(serverEnvironment.skillsImport);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(project?.id ?? null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<ReadonlyArray<SkillImportItemResult>>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const selectedProject =
    project ?? projects.find((candidate) => candidate.id === selectedProjectId);
  const scan = useEnvironmentQuery(
    open && selectedProject !== undefined
      ? serverEnvironment.skillsImportScan({
          environmentId: selectedProject.environmentId,
          input: { projectId: selectedProject.id, target },
        })
      : null,
  );

  useEffect(() => {
    if (!open) return;
    setSelectedProjectId(project?.id ?? null);
    setSelectedCandidateIds(new Set());
    setResults([]);
    setImportError(null);
  }, [open, project?.id]);

  useEffect(() => {
    if (scan.data === null) return;
    setSelectedCandidateIds(initialSkillImportSelection(scan.data.candidates));
    setResults([]);
  }, [scan.data]);

  const resultByCandidate = useMemo(() => indexSkillImportResults(results), [results]);
  const candidates = scan.data?.candidates ?? [];

  const runImport = async () => {
    if (selectedProject === undefined || selectedCandidateIds.size === 0) return;
    setImporting(true);
    setImportError(null);
    const result = await importSkills({
      environmentId: selectedProject.environmentId,
      input: {
        projectId: selectedProject.id,
        target,
        candidateIds: [...selectedCandidateIds],
      },
    });
    setImporting(false);
    if (result._tag === "Success") {
      setResults(result.value.items);
      onImported();
      return;
    }
    setImportError("The selected skills could not be imported.");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import skills</DialogTitle>
          <DialogDescription>
            Scan a project workspace and import selected filesystem skills as {target} skills.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col gap-4">
          {target === "global" ? (
            <Field>
              <FieldLabel>Project to scan</FieldLabel>
              <FieldDescription>
                Files are read from this project, but imported skills will be global.
              </FieldDescription>
              <Select
                items={projects.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.title,
                }))}
                value={selectedProjectId}
                onValueChange={(value) => setSelectedProjectId(value as ProjectId | null)}
              >
                <SelectTrigger className="max-w-md">
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectPopup>
                  <SelectGroup>
                    {projects.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectPopup>
              </Select>
            </Field>
          ) : null}

          {selectedProject === undefined ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderSearchIcon />
                </EmptyMedia>
                <EmptyTitle>Choose a project</EmptyTitle>
                <EmptyDescription>Select the workspace that should be scanned.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : scan.isPending && scan.data === null ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          ) : scan.error !== null ? (
            <Alert variant="error">
              <AlertCircleIcon />
              <AlertTitle>Workspace scan failed</AlertTitle>
              <AlertDescription>{scan.error}</AlertDescription>
            </Alert>
          ) : candidates.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderSearchIcon />
                </EmptyMedia>
                <EmptyTitle>No filesystem skills found</EmptyTitle>
                <EmptyDescription>
                  Add a SKILL.md under .claude, .agents, .cursor, or .codex skills.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ScrollArea className="max-h-[28rem] rounded-xl border">
              <div className="flex flex-col divide-y">
                {candidates.map((candidate) => {
                  const result = resultByCandidate.get(candidate.candidateId);
                  return (
                    <Field
                      key={candidate.candidateId}
                      className="gap-0 px-4 py-3"
                      data-disabled={!candidate.valid || undefined}
                    >
                      <FieldLabel className="w-full cursor-pointer items-start gap-3">
                        <Checkbox
                          checked={selectedCandidateIds.has(candidate.candidateId)}
                          disabled={!candidate.valid || importing}
                          onCheckedChange={() =>
                            setSelectedCandidateIds((selected) =>
                              toggleSkillImportSelection(selected, candidate),
                            )
                          }
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <span>{candidate.title}</span>
                            <Badge variant="outline">{candidate.slug || "Invalid slug"}</Badge>
                            {candidate.locations.map((location) => (
                              <Badge key={location.path} variant="secondary">
                                .{location.source}
                              </Badge>
                            ))}
                            {result ? (
                              <Badge variant={outcomeVariant(result.outcome)}>
                                {skillImportOutcomeLabel(result.outcome)}
                              </Badge>
                            ) : null}
                          </span>
                          <span className="text-xs font-normal text-muted-foreground">
                            {candidate.invalidReason ??
                              (candidate.existing?.state === "unchanged"
                                ? "Matches the active database version."
                                : candidate.existing?.state === "differs"
                                  ? "Will create a new version of the existing skill."
                                  : candidate.description || `${candidate.contentBytes} bytes`)}
                          </span>
                          {result?.message ? (
                            <span className="text-xs font-normal text-muted-foreground">
                              {result.message}
                            </span>
                          ) : null}
                        </span>
                      </FieldLabel>
                    </Field>
                  );
                })}
              </div>
            </ScrollArea>
          )}
          {importError ? (
            <Alert variant="error">
              <AlertCircleIcon />
              <AlertTitle>Import failed</AlertTitle>
              <AlertDescription>{importError}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={selectedProject === undefined || selectedCandidateIds.size === 0 || importing}
            onClick={() => void runImport()}
          >
            {importing ? <Spinner data-icon="inline-start" /> : null}
            Import {selectedCandidateIds.size || ""}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

import { useState } from "react";
import {
  ProviderInstanceId,
  type ComputerUseProviderStatus,
  type ComputerUseTestResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  MousePointer2Icon,
  RefreshCwIcon,
} from "lucide-react";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  COMPUTER_USE_REMEDIATION_COPY,
  deriveComputerUseQueryState,
  effectiveComputerUseRemediation,
  presentComputerUseStatus,
} from "./computerUsePresentation";

const COMPUTER_USE_TARGET_COPY = {
  "t3-packaged": "installed app",
  "t3-electron-dev": "dev build",
  "not-found": "not found",
} as const;

function DiagnosticMetadata({ result }: { readonly result: ComputerUseTestResult }) {
  const checks = [
    ["Runtime", result.metadata.runtimeInitialized],
    ["App discovery", result.metadata.appDiscoverySucceeded],
    ["T3 Code found", result.metadata.targetAppFound],
    ["Accessibility", result.metadata.accessibilityAvailable],
    ["Screenshot", result.metadata.screenshotAvailable],
  ] as const;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Computer Use test metadata">
      {checks.map(([label, passed]) => (
        <Badge key={label} variant={passed ? "success" : "error"}>
          {label}: {passed ? "Yes" : "No"}
        </Badge>
      ))}
      <Badge variant="secondary">
        Target: {COMPUTER_USE_TARGET_COPY[result.metadata.targetKind]}
      </Badge>
      <Badge variant="secondary">Apps: {result.metadata.discoveredAppCount}</Badge>
      <Badge variant="secondary">
        Accessibility length: {result.metadata.accessibilityTextLength}
      </Badge>
    </div>
  );
}

function SetupGuidance() {
  return (
    <Alert variant="info">
      <MousePointer2Icon aria-hidden />
      <AlertTitle>Provider-native setup</AlertTitle>
      <AlertDescription>
        <ol className="list-decimal pl-4">
          <li>
            Install the ChatGPT/Codex desktop host app. It supplies native runtime assets; its UI
            does not need to remain open.
          </li>
          <li>
            In ChatGPT desktop, open Work or Codex → Plugins and install or enable Computer Use.
          </li>
          <li>Enable the plugin&apos;s MCP and Computer Use skill capability.</li>
          <li>
            Grant macOS Accessibility and Screen Recording permissions, then allow the required
            applications when prompted.
          </li>
          <li>Start a new T3 Codex session after setup or permission changes.</li>
        </ol>
      </AlertDescription>
    </Alert>
  );
}

function Remediation({
  status,
  result,
}: {
  readonly status: ComputerUseProviderStatus;
  readonly result: ComputerUseTestResult | null;
}) {
  const steps = effectiveComputerUseRemediation(status, result);
  if (steps.length === 0) return null;
  return (
    <Alert variant={result?.passed ? "success" : "warning"}>
      {result?.passed ? <CheckCircle2Icon aria-hidden /> : <AlertTriangleIcon aria-hidden />}
      <AlertTitle>{result?.passed ? "Diagnostic passed" : "What to do next"}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {steps.map((step) => (
            <li key={step}>{COMPUTER_USE_REMEDIATION_COPY[step]}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function ComputerUseSettingsContent(props: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd?: string;
}) {
  const environmentId = props.environmentId;
  const statusQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.computerUseStatus({
          environmentId,
          input: props.cwd ? { cwd: props.cwd } : {},
        }),
  );
  const testComputerUse = useAtomCommand(serverEnvironment.testComputerUse, {
    label: "test Computer Use",
    reportFailure: false,
  });
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderInstanceId | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<ProviderInstanceId | null>(null);
  const [results, setResults] = useState<Record<string, ComputerUseTestResult>>({});
  const [testRequestFailed, setTestRequestFailed] = useState(false);
  const providers = statusQuery.data?.providers ?? [];
  const selectedStatus =
    providers.find((provider) => provider.providerInstanceId === selectedProviderId) ??
    providers[0];
  const selectedResult = selectedStatus
    ? (results[selectedStatus.providerInstanceId] ?? null)
    : null;
  const presentation = selectedStatus
    ? presentComputerUseStatus(selectedStatus, selectedResult)
    : null;
  const queryState = deriveComputerUseQueryState({
    isPending: statusQuery.isPending,
    hasData: statusQuery.data !== null,
    providerCount: providers.length,
    error: statusQuery.error,
  });

  const runTest = async () => {
    if (!environmentId || !selectedStatus || testingProviderId !== null) return;
    setTestRequestFailed(false);
    setTestingProviderId(selectedStatus.providerInstanceId);
    try {
      const result = await testComputerUse({
        environmentId,
        input: {
          providerInstanceId: selectedStatus.providerInstanceId,
          ...(props.cwd ? { cwd: props.cwd } : {}),
        },
      });
      if (result._tag === "Success") {
        setResults((current) => ({
          ...current,
          [selectedStatus.providerInstanceId]: result.value,
        }));
      } else {
        setTestRequestFailed(true);
      }
    } catch {
      setTestRequestFailed(true);
    } finally {
      setTestingProviderId(null);
    }
  };

  const isTesting = testingProviderId === selectedStatus?.providerInstanceId;
  const refreshStatus = () => {
    setResults({});
    setTestRequestFailed(false);
    statusQuery.refresh();
  };

  return (
    <SettingsSection title="Computer Use">
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            <MousePointer2Icon className="size-4 text-muted-foreground" aria-hidden />
            Codex Computer Use
          </span>
        }
        description="Status and setup for Codex's provider-native Computer Use integration. This does not add duplicate click, type, or screenshot tools to the T3 Code MCP."
        status={
          <span className="flex flex-wrap items-center gap-2">
            {presentation ? (
              <>
                <Badge variant={presentation.badgeVariant}>{presentation.label}</Badge>
                <span>{presentation.summary}</span>
              </>
            ) : queryState === "loading" ? (
              <>
                <Spinner /> Checking the effective Codex configuration…
              </>
            ) : queryState === "error" ? (
              "Computer Use status could not be loaded."
            ) : (
              "No configured Codex provider is available to check."
            )}
          </span>
        }
        control={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            {providers.length > 1 ? (
              <Select
                items={providers.map((provider) => ({
                  value: provider.providerInstanceId,
                  label: provider.providerDisplayName,
                }))}
                value={selectedStatus?.providerInstanceId ?? null}
                onValueChange={(value) =>
                  value && setSelectedProviderId(ProviderInstanceId.make(value))
                }
              >
                <SelectTrigger className="w-44" aria-label="Codex provider instance">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectGroup>
                    {providers.map((provider) => (
                      <SelectItem
                        key={provider.providerInstanceId}
                        value={provider.providerInstanceId}
                      >
                        {provider.providerDisplayName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectPopup>
              </Select>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!selectedStatus || isTesting || statusQuery.isPending}
              onClick={() => void runTest()}
            >
              {isTesting ? <Spinner data-icon="inline-start" /> : null}
              Test Computer Use
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh Computer Use status"
              disabled={statusQuery.isPending}
              onClick={refreshStatus}
            >
              <RefreshCwIcon data-icon="inline-start" />
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 py-3.5">
          {selectedResult ? <DiagnosticMetadata result={selectedResult} /> : null}
          {testRequestFailed ? (
            <Alert variant="error">
              <AlertTriangleIcon aria-hidden />
              <AlertTitle>Test request failed</AlertTitle>
              <AlertDescription>
                The server could not run the diagnostic. Check the connection and try again.
              </AlertDescription>
            </Alert>
          ) : null}
          {selectedStatus ? <Remediation status={selectedStatus} result={selectedResult} /> : null}
          <SetupGuidance />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

export function ComputerUseSettingsSection(props: {
  readonly environmentId?: EnvironmentId;
  readonly cwd?: string;
}) {
  const primaryEnvironmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const environmentId = props.environmentId ?? primaryEnvironmentId;
  const scopeKey = `${environmentId ?? "unavailable"}:${props.cwd ?? "global"}`;

  return (
    <ComputerUseSettingsContent
      key={scopeKey}
      environmentId={environmentId}
      {...(props.cwd ? { cwd: props.cwd } : {})}
    />
  );
}

import {
  descriptorsFromCapabilities,
  DESCRIPTOR_PRESETS_BY_KIND,
  emptyEditorDescriptor,
  descriptorFromPreset,
  definitionFromDraft,
  draftFromDefinition,
  emptyEditorChoice,
  type CustomModelDraft,
  type EditorDescriptor,
  validateDraft,
  type EditorChoice,
} from "./customModelEditor.logic";
import { Switch } from "../ui/switch";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { cn } from "../../util/utils";
import type { CustomModelDefinition } from "@kora/shared/modelOptions";
import type { AgentModel, AgentId } from "@kora/contracts";
import { type KeyboardEvent, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";

const CUSTOM_ID = "__custom__";

const customModelEditorCls1 = "flex flex-wrap items-center justify-between gap-2";

export function CustomModelEditor(props: {
  instanceId: string;
  driverKind: AgentId | null;
  entry: CustomModelDefinition;
  builtInModels: ReadonlyArray<AgentModel>;
  onSave: (next: CustomModelDefinition) => void;
  onCancel: () => void;
}) {
  const { instanceId, driverKind, entry, builtInModels, onSave, onCancel } = props;
  const [draft, setDraft] = useState<CustomModelDraft>(() => draftFromDefinition(entry));
  const [error, setError] = useState<string | null>(null);

  const presets = (driverKind ? DESCRIPTOR_PRESETS_BY_KIND[driverKind] : undefined) ?? [];
  const copyCandidates = builtInModels.filter(
    (model) => (model.capabilities?.optionDescriptors?.length ?? 0) > 0,
  );
  const nameId = `provider-instance-${instanceId}-custom-model-name`;

  const setDescriptors = (descriptors: ReadonlyArray<EditorDescriptor>) => {
    setDraft((current) => ({ ...current, descriptors }));
    setError(null);
  };
  const updateDescriptor = (key: string, patch: Partial<EditorDescriptor>) =>
    setDescriptors(
      draft.descriptors.map((descriptor) =>
        descriptor.key === key ? { ...descriptor, ...patch } : descriptor,
      ),
    );
  const updateChoices = (
    key: string,
    change: (choices: ReadonlyArray<EditorChoice>) => ReadonlyArray<EditorChoice>,
  ) => {
    const descriptor = draft.descriptors.find((candidate) => candidate.key === key);
    if (descriptor) updateDescriptor(key, { choices: change(descriptor.choices) });
  };

  const save = () => {
    const complaint = validateDraft(draft);
    if (complaint) {
      return setError(complaint);
    }
    onSave(definitionFromDraft(draft));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    onCancel();
  };

  const presetIds = new Set(presets.map((preset) => preset.id));
  const usedIds = new Set(draft.descriptors.map((descriptor) => descriptor.id.trim()));

  const selectBlock =
    copyCandidates.length > 0 ? (
      <Select
        value="copy"
        onValueChange={(slug) => {
          const source = copyCandidates.find((model) => model.slug === slug);
          if (source) setDescriptors(descriptorsFromCapabilities(source.capabilities, driverKind));
        }}
      >
        <SelectTrigger
          aria-label="Copy options from a built-in model"
          className="w-44"
          size="compact"
        >
          <SelectValue>Copy from…</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} align="end">
          {copyCandidates.map(({ slug, name }) => (
            <SelectItem value={slug} key={slug}>
              {name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : null;

  const pBlock =
    draft.descriptors.length === 0 ? (
      <p className="text-xs text-muted-foreground/70">
        No custom options. The composer uses the provider's default options.
      </p>
    ) : null;

  return (
    <div
      className="mx-2 mt-1 mb-2 flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3"
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs text-muted-foreground">
          Display name
        </label>
        <Input
          id={nameId}
          autoFocus
          size="sm"
          className="sm:w-72"
          placeholder={entry.slug}
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className={customModelEditorCls1}>
          <span className="text-xs text-muted-foreground">Options shown in the composer</span>
          {selectBlock}
        </div>

        {pBlock}

        {draft.descriptors.map((descriptor, index) => {
          const isPresetId = presetIds.has(descriptor.id);
          const divBlock =
            descriptor.type === "select" ? (
              <div className="flex flex-col gap-1.5 pl-16">
                {descriptor.choices.map((choice) => (
                  <div key={choice.key} className="flex items-center gap-2">
                    <Input
                      size="compact"
                      className="w-28 font-mono"
                      placeholder="value"
                      aria-label="Choice value"
                      value={choice.id}
                      onChange={(event) =>
                        updateChoices(descriptor.key, (choices) =>
                          choices.map((c) =>
                            c.key === choice.key ? { ...c, id: event.target.value } : c,
                          ),
                        )
                      }
                    />
                    <Input
                      size="compact"
                      className="min-w-0 flex-1"
                      placeholder="Label"
                      aria-label="Choice label"
                      value={choice.label}
                      onChange={(event) =>
                        updateChoices(descriptor.key, (choices) =>
                          choices.map((c) =>
                            c.key === choice.key ? { ...c, label: event.target.value } : c,
                          ),
                        )
                      }
                    />
                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      Default
                      <Switch
                        size="sm"
                        aria-label="Default choice"
                        checked={choice.isDefault}
                        onCheckedChange={(checked) =>
                          // Exactly one default: switching one on switches the others off.
                          updateChoices(descriptor.key, (choices) =>
                            choices.map((c) => ({
                              ...c,
                              isDefault: checked && c.key === choice.key,
                            })),
                          )
                        }
                      />
                    </label>
                    <Button
                      variant="ghost-muted"
                      size="icon-micro"
                      aria-label="Remove choice"
                      onClick={() =>
                        updateChoices(descriptor.key, (choices) =>
                          choices.filter((c) => c.key !== choice.key),
                        )
                      }
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                ))}
                <Button
                  onClick={() =>
                    updateChoices(descriptor.key, (choices) => [...choices, emptyEditorChoice()])
                  }
                  className="-ml-2 self-start"
                  variant="ghost-muted"
                  size="xs"
                >
                  <PlusIcon className="size-3" />
                  Add choice
                </Button>
              </div>
            ) : null;

          const selectPopupKids = (
            <>
              <SelectItem value="select">Choices</SelectItem>
              <SelectItem value="boolean">Toggle</SelectItem>
            </>
          );

          const selectPopupPart = (
            <SelectPopup alignItemWithTrigger={false} align="end">
              {selectPopupKids}
            </SelectPopup>
          );

          return (
            <div
              className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-2.5"
              key={descriptor.key}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
                  Option {index + 1}
                </span>
                {presets.length > 0 ? (
                  <Select
                    value={isPresetId ? descriptor.id : CUSTOM_ID}
                    onValueChange={(next) => {
                      if (next === CUSTOM_ID) {
                        updateDescriptor(descriptor.key, { id: "" });
                        return;
                      }
                      const preset = presets.find((candidate) => candidate.id === next);
                      if (!preset) return;
                      const fresh = descriptorFromPreset(preset);
                      updateDescriptor(descriptor.key, {
                        id: fresh.id,
                        label: fresh.label,
                        type: fresh.type,
                        choices: fresh.choices,
                        currentBooleanValue: undefined,
                        description: undefined,
                      });
                    }}
                  >
                    <SelectTrigger size="compact" className="w-40" aria-label="Option id">
                      <SelectValue>{isPresetId ? descriptor.id : "Custom…"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false} align="start">
                      {presets.map((preset) => (
                        <SelectItem value={preset.id} key={preset.id}>
                          <span className="flex items-baseline gap-2">
                            <span className="font-mono text-xs">{preset.id}</span>
                            <span className="text-muted-foreground">{preset.label}</span>
                          </span>
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_ID}>Custom…</SelectItem>
                    </SelectPopup>
                  </Select>
                ) : null}
                {!isPresetId ? (
                  <Input
                    size="compact"
                    className="w-36 font-mono"
                    placeholder="optionId"
                    aria-label="Option id"
                    value={descriptor.id}
                    onChange={(event) =>
                      updateDescriptor(descriptor.key, { id: event.target.value })
                    }
                  />
                ) : null}
                <Input
                  size="compact"
                  className="min-w-0 flex-1"
                  placeholder="Label"
                  aria-label="Option label"
                  value={descriptor.label}
                  onChange={(event) =>
                    updateDescriptor(descriptor.key, { label: event.target.value })
                  }
                />
                <Select
                  value={descriptor.type}
                  onValueChange={(next) => {
                    if (next === "select" || next === "boolean")
                      updateDescriptor(descriptor.key, { type: next });
                  }}
                >
                  <SelectTrigger size="compact" className="w-24" aria-label="Option type">
                    <SelectValue>{descriptor.type === "select" ? "Choices" : "Toggle"}</SelectValue>
                  </SelectTrigger>
                  {selectPopupPart}
                </Select>
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  aria-label={`Remove option ${index + 1}`}
                  onClick={() =>
                    setDescriptors(
                      draft.descriptors.filter((candidate) => candidate.key !== descriptor.key),
                    )
                  }
                >
                  <XIcon className="size-3" />
                </Button>
              </div>

              {divBlock}
            </div>
          );
        })}

        <div className="flex flex-wrap gap-1">
          {presets
            .filter((preset) => !usedIds.has(preset.id))
            .map((preset, index) => (
              <Button
                key={preset.id}
                variant="ghost-muted"
                size="xs"
                className={cn(index > 0 && "-ml-2")}
                onClick={() => setDescriptors([...draft.descriptors, descriptorFromPreset(preset)])}
              >
                <PlusIcon className="size-3" />
                {preset.label}
              </Button>
            ))}
          <Button
            variant="ghost-muted"
            size="xs"
            className={cn(presets.some((preset) => !usedIds.has(preset.id)) && "-ml-2")}
            onClick={() => setDescriptors([...draft.descriptors, emptyEditorDescriptor()])}
          >
            <PlusIcon className="size-3" />
            Custom option
          </Button>
        </div>
      </div>

      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={save}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

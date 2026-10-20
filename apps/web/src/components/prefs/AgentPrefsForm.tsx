import { PrefsRow } from "./prefsLayout";
import type { AgentClientDefinition } from "./agentDriverMeta";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import { Input } from "../ui/input";
import { DraftInput } from "../ui/commit-input";
import { cn } from "../../util/utils";
import type {
  AgentPrefsFormSchemaAnnotation,
  AgentPrefsFormAnnotation,
  AgentPrefsFormControl,
  AgentPrefsFormOption,
} from "@kora/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

export interface AgentPrefsFieldModel {
  /** For selects. The first entry is the default. */
  readonly options?: ReadonlyArray<AgentPrefsFormOption>;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly control: AgentPrefsFormControl;
  readonly defaultBooleanValue?: boolean;
  readonly placeholder?: string;
  readonly description?: string;
  readonly label: string;
  readonly key: string;
}

type Annotations = Readonly<Record<string, unknown>>;

function fieldAnnotations(field: Schema.Top): Annotations {
  const ast = field.ast as unknown as {
    context?: { annotations?: Annotations };
    annotations?: Annotations;
  };
  return { ...ast.annotations, ...ast.context?.annotations };
}

function titleCase(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function deriveAgentPrefsFields(
  definition: AgentClientDefinition,
): ReadonlyArray<AgentPrefsFieldModel> {
  const schemaNote = (definition.settingsSchema.ast.annotations?.providerSettingsFormSchema ??
    {}) as AgentPrefsFormSchemaAnnotation;
  const order = schemaNote.order ?? [];
  const keys = Object.keys(definition.settingsSchema.fields);
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  const sorted = keys
    .map((key, position) => ({ key, position }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.position - b.position)
    .map((entry) => entry.key);

  const fields: AgentPrefsFieldModel[] = [];
  for (const key of sorted) {
    const schema = definition.settingsSchema.fields[key]!;
    const notes = fieldAnnotations(schema);
    const form = (notes.providerSettingsForm ?? {}) as AgentPrefsFormAnnotation;
    if (form.hidden) continue;

    const control = form.control ?? "text";
    let defaultBooleanValue: boolean | undefined;
    if (control === "switch") {
      const decoded = Schema.decodeUnknownOption(schema as never)(
        undefined,
      ) as Option.Option<unknown>;
      if (Option.isSome(decoded) && typeof decoded.value === "boolean") {
        defaultBooleanValue = decoded.value;
      }
    }
    fields.push({
      key,
      control,
      label: typeof notes.title === "string" ? notes.title : titleCase(key),
      ...(typeof notes.description === "string" ? { description: notes.description } : {}),
      ...(form.placeholder !== undefined ? { placeholder: form.placeholder } : {}),
      clearWhenEmpty: form.clearWhenEmpty ?? "omit",
      ...(defaultBooleanValue !== undefined ? { defaultBooleanValue } : {}),
      ...(control === "select" && form.options ? { options: form.options } : {}),
    });
  }
  return fields;
}

export function nextAgentConfigWithFieldValue(
  config: unknown,
  field: AgentPrefsFieldModel,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> =
    typeof config === "object" && config !== null && !Array.isArray(config)
      ? { ...(config as Record<string, unknown>) }
      : {};
  const isDefault =
    typeof value === "boolean"
      ? value === (field.defaultBooleanValue ?? false)
      : value.trim() === "";
  if (field.clearWhenEmpty === "omit" && isDefault) delete next[field.key];
  else next[field.key] = value; // strings are stored untrimmed
  return Object.keys(next).length > 0 ? next : undefined;
}

function readString(config: unknown, key: string): string {
  const value = (config as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

function readBoolean(config: unknown, field: AgentPrefsFieldModel): boolean {
  const value = (config as Record<string, unknown> | null | undefined)?.[field.key];
  return typeof value === "boolean" ? value : (field.defaultBooleanValue ?? false);
}

type Variant = "card" | "dialog" | "settings";

export function AgentPrefsForm(props: {
  definition: AgentClientDefinition;
  value: unknown;
  idPrefix: string;
  variant: Variant;
  onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}) {
  const { definition, value, idPrefix, variant, onChange } = props;
  const fields = deriveAgentPrefsFields(definition);
  if (fields.length === 0) return null;

  const write = (field: AgentPrefsFieldModel, next: string | boolean) =>
    onChange(nextAgentConfigWithFieldValue(value, field, next));

  const renderControl = (field: AgentPrefsFieldModel) => {
    const id = `${idPrefix}-${field.key}`;
    const described = field.description ? `${id}-description` : undefined;
    const wide = variant === "settings";

    switch (field.control) {
      case "switch":
        return (
          <Switch
            id={id}
            aria-label={field.label}
            aria-describedby={described}
            checked={readBoolean(value, field)}
            onCheckedChange={(checked) => write(field, checked)}
          />
        );
      case "select": {
        const options = field.options ?? [];
        const first = options[0]?.value ?? "";
        const stored = readString(value, field.key);
        const current = stored || first;
        return (
          <Select
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              write(field, next === first ? "" : next);
            }}
            value={current}
          >
            <SelectTrigger
              id={id}
              size="sm"
              aria-label={field.label}
              aria-describedby={described}
              className={cn("w-full", wide && "sm:w-56")}
            >
              <SelectValue>
                {options.find((option) => option.value === current)?.label ?? current}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false} align="start">
              {options.map(({ value, label }) => (
                <SelectItem value={value} key={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        );
      }
      case "textarea":
        return (
          <Textarea
            id={id}
            spellCheck={false}
            aria-describedby={described}
            placeholder={field.placeholder}
            className={cn("w-full", wide && "sm:w-96")}
            value={readString(value, field.key)}
            onChange={(event) => write(field, event.target.value)}
          />
        );
      default: {
        const type = field.control === "password" ? "password" : "text";
        if (variant === "dialog") {
          return (
            <Input
              id={id}
              type={type}
              size="sm"
              spellCheck={false}
              autoComplete={type === "password" ? "off" : undefined}
              aria-describedby={described}
              placeholder={field.placeholder}
              className="bg-background"
              value={readString(value, field.key)}
              onChange={(event) => write(field, event.target.value)}
            />
          );
        }
        return (
          <DraftInput
            id={id}
            type={type}
            size="sm"
            spellCheck={false}
            autoComplete={type === "password" ? "off" : undefined}
            aria-describedby={described}
            placeholder={field.placeholder}
            className={cn("w-full", wide && "sm:w-56")}
            value={readString(value, field.key)}
            onCommit={(next) => write(field, next)}
          />
        );
      }
    }
  };

  return (
    <>
      {fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const isSwitch = field.control === "switch";
        const description = field.description ? (
          <span
            id={`${id}-description`}
            className={cn(
              "text-muted-foreground",
              variant === "dialog" ? "text-[11px]" : "mt-1 block text-xs",
            )}
          >
            {field.description}
          </span>
        ) : null;

        if (variant === "settings") {
          return (
            <PrefsRow
              key={field.key}
              title={isSwitch ? field.label : <label htmlFor={id}>{field.label}</label>}
              description={description}
              control={renderControl(field)}
            />
          );
        }

        if (isSwitch) {
          return (
            <div key={field.key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-xs font-medium text-foreground">{field.label}</span>
                {description}
              </div>
              {renderControl(field)}
            </div>
          );
        }

        if (variant === "dialog") {
          return (
            <div key={field.key} className="grid gap-1.5">
              <label htmlFor={id} className="text-xs font-medium text-foreground">
                {field.label}
              </label>
              {renderControl(field)}
              {description}
            </div>
          );
        }

        return (
          <div key={field.key}>
            <label htmlFor={id} className="text-xs font-medium text-foreground">
              {field.label}
            </label>
            <div className="mt-1.5">{renderControl(field)}</div>
            {description}
          </div>
        );
      })}
    </>
  );
}

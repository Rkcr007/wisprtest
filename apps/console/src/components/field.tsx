'use client';

import type { ReactNode } from 'react';

/**
 * Form primitives, styled from `packages/ui` tokens.
 *
 * Deliberately not shadcn/ui: those components are Tailwind-and-Radix, and `packages/ui` is a
 * custom-property stylesheet the extension HUD adopts into a shadow root. Pulling a second
 * styling system in for two screens would mean two sets of colours claiming to be the same
 * design, which is precisely the drift the shared package exists to prevent. The accessibility
 * behaviour shadcn would have given us — label association, `aria-invalid`, `aria-describedby`,
 * a described error — is implemented here instead, and asserted in the component tests.
 */

interface FieldShellProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}

function describedBy(props: { id: string; hint?: string; error?: string | undefined }): string | undefined {
  const ids = [
    props.hint === undefined ? null : `${props.id}-hint`,
    props.error === undefined ? null : `${props.id}-error`,
  ].filter((value): value is string => value !== null);
  return ids.length === 0 ? undefined : ids.join(' ');
}

function FieldShell({ id, label, hint, error, children }: FieldShellProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface InputProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly placeholder?: string;
  readonly required?: boolean;
}

export function TextField(props: InputProps & { readonly type?: 'text' | 'url' }) {
  const { id, label, value, onChange, hint, error, placeholder, required, type = 'text' } = props;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        type={type}
        value={value}
        required={required ?? false}
        placeholder={placeholder}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy({ id, hint, error })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </FieldShell>
  );
}

export function NumberField(props: InputProps) {
  const { id, label, value, onChange, hint, error, placeholder } = props;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy({ id, hint, error })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </FieldShell>
  );
}

export function TextAreaField(props: InputProps & { readonly rows?: number }) {
  const { id, label, value, onChange, hint, error, placeholder, rows } = props;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        rows={rows ?? 3}
        value={value}
        placeholder={placeholder}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy({ id, hint, error })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </FieldShell>
  );
}

export function SelectField<T extends string>(props: {
  readonly id: string;
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly hint?: string;
}) {
  const { id, label, value, options, onChange, hint } = props;
  return (
    <FieldShell id={id} label={label} hint={hint}>
      <select
        id={id}
        value={value}
        aria-describedby={describedBy({ id, hint })}
        onChange={(event) => {
          onChange(event.target.value as T);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

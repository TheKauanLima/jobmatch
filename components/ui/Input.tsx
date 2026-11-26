import { InputHTMLAttributes, Ref } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Forwarded to the `<input>` (React 19 ref-as-prop), e.g. to move focus to it. */
  ref?: Ref<HTMLInputElement>;
}

export function Input({ label, id, className = "", ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        className={`min-h-11 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg transition-colors sm:min-h-0 placeholder:text-fg-disabled focus:border-fg-subtle focus:outline-none focus:ring-1 focus:ring-fg-subtle disabled:bg-surface-hover disabled:text-fg-subtle ${className}`}
        {...props}
      />
    </div>
  );
}

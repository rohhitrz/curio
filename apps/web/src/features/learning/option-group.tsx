'use client';

import { cn } from '@/lib/utils';

interface OptionGroupProps<T extends string> {
  legend: string;
  name: string;
  options: { value: T; label: string; hint: string }[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** Radio buttons drawn as cards: one choice, keyboard friendly (native radios underneath). */
export function OptionGroup<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  disabled,
}: OptionGroupProps<T>) {
  return (
    <fieldset disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'hover:bg-muted/50 flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-colors',
              'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]',
              value === option.value && 'border-primary bg-muted/50',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span className="text-sm font-medium">{option.label}</span>
            <span className="text-muted-foreground mt-0.5 text-xs">{option.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

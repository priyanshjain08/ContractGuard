import type { HTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn('rounded-lg border border-line bg-panel p-4', className)} {...p} />;
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cn('h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-brand', className)} {...p} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cn('w-full rounded-md border border-line bg-bg p-3 font-mono text-xs outline-none focus:border-brand', className)} {...p} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cn('h-9 rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-brand', className)} {...p} />;
export const Label = ({ className, ...p }: LabelHTMLAttributes<HTMLLabelElement>) => <label className={cn('mb-1 block text-xs text-muted', className)} {...p} />;

const TONES: Record<string, string> = {
  BREAKING: 'bg-danger/15 text-danger', POTENTIALLY_BREAKING: 'bg-warn/15 text-warn', NON_BREAKING: 'bg-ok/15 text-ok', INFORMATIONAL: 'bg-brand/15 text-brand',
  FAIL: 'bg-danger/15 text-danger', NEEDS_REVIEW: 'bg-warn/15 text-warn', PASS: 'bg-ok/15 text-ok', COMPLETED: 'bg-ok/15 text-ok',
  QUEUED: 'bg-muted/20 text-muted', RUNNING: 'bg-brand/15 text-brand', FAILED: 'bg-danger/15 text-danger', SUPPRESSED: 'bg-muted/20 text-muted', WARN: 'bg-warn/15 text-warn',
  critical: 'bg-danger/20 text-danger', high: 'bg-danger/15 text-danger', medium: 'bg-warn/15 text-warn', low: 'bg-ok/15 text-ok', info: 'bg-brand/15 text-brand',
};
export function Badge({ value, className }: { value: string; className?: string }) {
  return <span className={cn('inline-block rounded px-2 py-0.5 text-[11px] font-medium', TONES[value] ?? 'bg-panel-2 text-muted', className)}>{value.replace(/_/g, ' ')}</span>;
}
export const Stat = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
  <Card><div className="text-xs text-muted">{label}</div><div className={cn('mt-1 text-2xl font-semibold', tone)}>{value}</div></Card>
);

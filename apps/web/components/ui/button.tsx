import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// shadcn/ui pattern (cva + tailwind-merge), written by hand because the shadcn CLI could not be run.
const variants = cva('inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition disabled:opacity-50 disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand', {
  variants: {
    variant: { default: 'bg-brand text-black hover:opacity-90', outline: 'border border-line bg-transparent hover:bg-panel-2', ghost: 'hover:bg-panel-2', destructive: 'bg-danger text-black hover:opacity-90' },
    size: { default: 'h-9 px-4', sm: 'h-8 px-3 text-xs' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});
export function Button({ className, variant, size, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof variants>) {
  return <button className={cn(variants({ variant, size }), className)} {...p} />;
}
export const buttonClass = (v: VariantProps<typeof variants> = {}) => variants(v);

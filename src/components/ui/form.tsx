import * as React from 'react';
import type * as LabelPrimitive from '@radix-ui/react-label';
import { Slot } from '@radix-ui/react-slot';
import { Controller, FormProvider, useFormContext, type ControllerProps, type FieldPath, type FieldValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

/**
 * shadcn/ui Form (react-hook-form + zod). Error messages may be i18n keys; FormMessage translates them.
 * Wires id / aria-describedby / aria-invalid automatically for screen readers.
 */
const Form = FormProvider;

type FormFieldContextValue<TFieldValues extends FieldValues = FieldValues, TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>> = { name: TName };
const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue);

const FormField = <TFieldValues extends FieldValues = FieldValues, TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>>({ ...props }: ControllerProps<TFieldValues, TName>) => (
  <FormFieldContext.Provider value={{ name: props.name }}>
    <Controller {...props} />
  </FormFieldContext.Provider>
);

const FormItemContext = React.createContext<{ id: string }>({} as { id: string });

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();
  const fieldState = getFieldState(fieldContext.name, formState);
  const { id } = itemContext;
  return { id, name: fieldContext.name, formItemId: `${id}-item`, formDescriptionId: `${id}-description`, formMessageId: `${id}-message`, ...fieldState };
};

const FormItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div ref={ref} className={cn('space-y-1.5', className)} {...props} />
    </FormItemContext.Provider>
  );
});
FormItem.displayName = 'FormItem';

const FormLabel = React.forwardRef<React.ElementRef<typeof LabelPrimitive.Root>, React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean }>(({ className, required, children, ...props }, ref) => {
  const { formItemId } = useFormField();
  return (
    <Label ref={ref} className={className} htmlFor={formItemId} {...props}>
      {children}
      {required && <span className="text-destructive" aria-hidden> *</span>}
    </Label>
  );
});
FormLabel.displayName = 'FormLabel';

const FormControl = React.forwardRef<React.ElementRef<typeof Slot>, React.ComponentPropsWithoutRef<typeof Slot>>(({ ...props }, ref) => {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
  return <Slot ref={ref} id={formItemId} aria-describedby={!error ? formDescriptionId : `${formDescriptionId} ${formMessageId}`} aria-invalid={!!error} {...props} />;
});
FormControl.displayName = 'FormControl';

const FormDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(({ className, ...props }, ref) => {
  const { formDescriptionId } = useFormField();
  return <p ref={ref} id={formDescriptionId} className={cn('text-xs text-muted-foreground', className)} {...props} />;
});
FormDescription.displayName = 'FormDescription';

const FormMessage = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(({ className, children, ...props }, ref) => {
  const { t } = useTranslation();
  const { error, formMessageId } = useFormField();
  const body = error ? t(String(error.message ?? '')) : children;
  if (!body) return null;
  return (
    <p ref={ref} id={formMessageId} role="alert" className={cn('text-xs font-medium text-destructive', className)} {...props}>
      {body}
    </p>
  );
});
FormMessage.displayName = 'FormMessage';

export { useFormField, Form, FormItem, FormLabel, FormControl, FormDescription, FormMessage, FormField };

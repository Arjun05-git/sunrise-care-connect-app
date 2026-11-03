import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowRight, Bell, CalendarCheck2, Check, Gift, Heart, Phone, Plus, Trash2, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Segmented } from '@/components/ui/segmented';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { InputOTP } from '@/components/ui/input-otp';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { EmptyState } from '@/components/feedback/EmptyState';
import { CardSkeleton, ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmergencyNotice } from '@/components/brand/EmergencyNotice';
import { Logo } from '@/components/brand/Logo';
import { BottomTabBar } from '@/components/layout/BottomTabBar';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { PageHeader } from '@/components/layout/PageHeader';
import { ADMIN_NAV, DOCTOR_NAV, PATIENT_NAV } from '@/routes/navigation';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { contrast, hslToRgb } from '@/lib/contrast';

type Mode = 'both' | 'light' | 'dark';

/**
 * Living style guide: every foundation component rendered twice – in a `.light` panel and a `.dark`
 * panel – using only design tokens, so theme regressions are visible at a glance.
 * Overlays (dialog, sheet, toast, tooltip) render in a portal and follow the global theme toggle.
 */
export function StyleGuidePage() {
  const { t } = useTranslation();
  const { resolved, setPrefs } = useTheme();
  const [mode, setMode] = useState<Mode>('both');
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/"><Logo /></Link>
          <div className="min-w-0">
            <h1 className="text-lg font-bold leading-tight">{t('styleGuide.title')}</h1>
            <p className="text-xs text-muted-foreground">{t('styleGuide.subtitle')}</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Segmented<Mode> className="w-auto" aria-label={t('styleGuide.view')} value={mode} onValueChange={setMode}
              options={[{ value: 'both', label: t('styleGuide.sideBySide') }, { value: 'light', label: t('settings.light') }, { value: 'dark', label: t('settings.dark') }]} />
            <Button variant="outline" size="sm" onClick={() => setPrefs({ theme: resolved === 'dark' ? 'light' : 'dark' })}>
              {t('styleGuide.overlayTheme', { theme: t(`settings.${resolved}`) })}
            </Button>
          </div>
        </div>
      </header>
      <div className={cn('mx-auto grid max-w-[1500px] gap-0', mode === 'both' && 'xl:grid-cols-2')}>
        {mode !== 'dark' && <Panel theme="light" />}
        {mode !== 'light' && <Panel theme="dark" />}
      </div>
    </div>
  );
}

function Panel({ theme }: { theme: 'light' | 'dark' }) {
  const { t } = useTranslation();
  return (
    <section className={cn(theme, 'min-w-0 bg-background px-4 py-6 text-foreground sm:px-6')} aria-label={t(`styleGuide.panel.${theme}`)} data-testid={`panel-${theme}`}>
      <div className="mb-6 flex items-center gap-2">
        <Badge variant={theme === 'light' ? 'highlight' : 'default'}>{t(`styleGuide.panel.${theme}`)}</Badge>
      </div>
      <div className="space-y-10">
        <Colors />
        <ContrastCheck />
        <Typography />
        <Buttons />
        <Badges />
        <Cards />
        <FormFields />
        <Choices />
        <TabsDemo />
        <Feedback />
        <Navigation />
        <Overlays />
      </div>
    </section>
  );
}

function Block({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {desc && <p className="mb-3 text-sm text-muted-foreground">{desc}</p>}
      <div className={cn(!desc && 'mt-3')}>{children}</div>
    </div>
  );
}

/* ----------------------------------------------------------------- colours */

const SWATCHES: { token: string; fg?: string; note: string }[] = [
  { token: 'background', fg: 'foreground', note: 'Page #F8FAFC' },
  { token: 'card', fg: 'card-foreground', note: 'Cards, sheets' },
  { token: 'primary', fg: 'primary-foreground', note: 'Teal #0F766E' },
  { token: 'primary-soft', fg: 'primary-soft-foreground', note: '#CCFBF1' },
  { token: 'highlight', fg: 'highlight-foreground', note: 'Amber #F59E0B' },
  { token: 'highlight-soft', fg: 'warning', note: 'Offers, free' },
  { token: 'success', fg: 'success-foreground', note: 'Success' },
  { token: 'warning', fg: 'warning-foreground', note: 'Warning' },
  { token: 'destructive', fg: 'destructive-foreground', note: 'Danger' },
  { token: 'muted', fg: 'muted-foreground', note: 'Slate neutrals' },
  { token: 'accent', fg: 'accent-foreground', note: 'Hover tint' },
  { token: 'border', fg: 'foreground', note: 'Lines, inputs' },
];

function Colors() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.colors')} desc={t('styleGuide.colorsDesc')}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {SWATCHES.map((s) => (
          <div key={s.token} className="overflow-hidden rounded-xl border">
            <div className="flex h-14 items-end p-2 text-xs font-semibold" style={{ background: `hsl(var(--${s.token}))`, color: s.fg ? `hsl(var(--${s.fg}))` : undefined }}>Aa</div>
            <div className="bg-card px-2 py-1.5">
              <p className="font-mono text-[11px] font-semibold">--{s.token}</p>
              <p className="text-[11px] text-muted-foreground">{s.note}</p>
            </div>
          </div>
        ))}
      </div>
    </Block>
  );
}

/** Computes WCAG contrast from the live CSS variables of this panel. */
function ContrastCheck() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<{ pair: string; ratio: number; min: number }[]>([]);
  useEffect(() => {
    if (!ref.current) return;
    const cs = getComputedStyle(ref.current);
    const rgb = (name: string) => hslToRgb(cs.getPropertyValue(`--${name}`).trim());
    const pairs: [string, string, number][] = [
      ['foreground', 'background', 4.5],
      ['muted-foreground', 'background', 4.5],
      ['muted-foreground', 'card', 4.5],
      ['primary-foreground', 'primary', 4.5],
      ['primary', 'card', 4.5],
      ['primary-soft-foreground', 'primary-soft', 4.5],
      ['highlight-foreground', 'highlight', 4.5],
      ['warning', 'highlight-soft', 4.5],
      ['success', 'success-soft', 4.5],
      ['destructive', 'destructive-soft', 4.5],
      ['destructive-foreground', 'destructive', 4.5],
      ['border', 'background', 1],
    ];
    setRows(pairs.map(([fg, bg, min]) => ({ pair: `${fg} / ${bg}`, ratio: contrast(rgb(fg), rgb(bg)), min })));
  }, []);
  return (
    <Block title={t('styleGuide.contrast')} desc={t('styleGuide.contrastDesc')}>
      <div ref={ref} className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('styleGuide.contrast')}</caption>
          <thead className="bg-muted text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-semibold">{t('styleGuide.pair')}</th><th className="px-3 py-2 font-semibold">{t('styleGuide.ratio')}</th><th className="px-3 py-2 font-semibold">AA</th></tr></thead>
          <tbody>
            {rows.filter((r) => r.min > 1).map((r) => (
              <tr key={r.pair} className="border-t">
                <td className="px-3 py-1.5 font-mono text-xs">{r.pair}</td>
                <td className="px-3 py-1.5 tabular-nums">{r.ratio.toFixed(2)}:1</td>
                <td className="px-3 py-1.5">{r.ratio >= r.min ? <Badge variant="success"><Check />{t('styleGuide.pass')}</Badge> : <Badge variant="destructive">{t('styleGuide.fail')}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

/* -------------------------------------------------------------- typography */

function Typography() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.typography')} desc={t('styleGuide.typographyDesc')}>
      <div className="space-y-2 rounded-xl border bg-card p-4">
        <p className="text-[28px] font-extrabold leading-tight tracking-tight">Display 28 / 800</p>
        <p className="text-2xl font-bold tracking-tight">Heading 1 · 24 / 700</p>
        <p className="text-lg font-semibold">Heading 2 · 18 / 600</p>
        <p className="text-base">Body 16 / 400 — {t('styleGuide.bodySample')}</p>
        <p className="text-sm text-muted-foreground">Secondary 14 / 400 — {t('styleGuide.mutedSample')}</p>
        <p className="text-xs text-muted-foreground">Caption 12 — {t('styleGuide.captionSample')}</p>
        <p lang="ml" className="font-ml text-base">മലയാളം: സൺറൈസ് ഡോക്ടർമാരുടെ പരിചരണം, നിങ്ങൾ എവിടെയായാലും.</p>
      </div>
    </Block>
  );
}

/* ----------------------------------------------------------------- buttons */

function Buttons() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.buttons')} desc={t('styleGuide.buttonsDesc')}>
      <div className="flex flex-wrap gap-2">
        <Button>{t('styleGuide.primary')}</Button>
        <Button variant="secondary">{t('styleGuide.secondary')}</Button>
        <Button variant="outline">{t('styleGuide.outline')}</Button>
        <Button variant="ghost">{t('styleGuide.ghost')}</Button>
        <Button variant="highlight"><Gift />{t('styleGuide.highlight')}</Button>
        <Button variant="destructive"><Trash2 />{t('common.delete')}</Button>
        <Button variant="link">{t('styleGuide.link')}</Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm">{t('styleGuide.small')}</Button>
        <Button>{t('styleGuide.default')}</Button>
        <Button size="lg">{t('styleGuide.large')}<ArrowRight /></Button>
        <Button size="icon" variant="outline" aria-label={t('styleGuide.add')}><Plus /></Button>
        <Button loading>{t('common.saving')}</Button>
        <Button disabled>{t('styleGuide.disabled')}</Button>
      </div>
      <Button block size="lg" className="mt-3"><Video />{t('styleGuide.blockCta')}</Button>
    </Block>
  );
}

function Badges() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.badges')}>
      <div className="flex flex-wrap gap-2">
        <Badge>{t('styleGuide.confirmed')}</Badge>
        <Badge variant="neutral">{t('styleGuide.rescheduled')}</Badge>
        <Badge variant="highlight"><Gift />{t('styleGuide.freeFollowUp')}</Badge>
        <Badge variant="success"><Check />{t('styleGuide.completed')}</Badge>
        <Badge variant="warning">{t('styleGuide.awaitingPayment')}</Badge>
        <Badge variant="destructive">{t('styleGuide.cancelled')}</Badge>
        <Badge variant="outline"><Video />{t('styleGuide.video')}</Badge>
      </div>
    </Block>
  );
}

function Cards() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.cards')} desc={t('styleGuide.cardsDesc')}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('styleGuide.cardTitle')}</CardTitle>
            <CardDescription>{t('styleGuide.cardDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">{t('styleGuide.cardBody')}</CardContent>
          <CardFooter><Button size="sm">{t('styleGuide.primary')}</Button><Button size="sm" variant="ghost">{t('common.cancel')}</Button></CardFooter>
        </Card>
        <Card className="overflow-hidden">
          <div className="bg-gradient-to-br from-primary to-primary/80 p-4 text-primary-foreground">
            <div className="flex items-center gap-3">
              <Avatar className="ring-2 ring-primary-foreground/40"><AvatarFallback>AN</AvatarFallback></Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">Dr. Arun Nair</p>
                <p className="truncate text-sm opacity-85">{t('styleGuide.cardiology')}</p>
              </div>
              <Badge className="bg-primary-foreground/20 text-primary-foreground"><Video />{t('styleGuide.video')}</Badge>
            </div>
            <p className="mt-3 flex items-center gap-2 text-sm"><CalendarCheck2 className="h-4 w-4" aria-hidden />Fri, 23 Oct · 5:00 pm IST</p>
          </div>
          <CardContent className="p-3"><Button block>{t('styleGuide.join')}</Button></CardContent>
        </Card>
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4 shadow-soft">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-foreground"><Heart className="h-5 w-5" aria-hidden /></div>
          <div><p className="text-2xl font-bold tabular-nums">128</p><p className="text-sm text-muted-foreground">{t('styleGuide.statLabel')}</p></div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-highlight/40 bg-highlight-soft p-4">
          <Gift className="h-5 w-5 text-warning" aria-hidden />
          <p className="flex-1 text-sm font-semibold">{t('styleGuide.freeFollowUp')}</p>
          <Button size="sm" variant="highlight">{t('styleGuide.book')}</Button>
        </div>
      </div>
    </Block>
  );
}

/* ------------------------------------------------------------- form fields */

const demoSchema = z.object({
  name: z.string().trim().min(2, 'validation.name'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'auth.err.invalid_phone'),
  notes: z.string().max(200).optional(),
  language: z.string().min(1, 'validation.required'),
});

function FormFields() {
  const { t } = useTranslation();
  const [otp, setOtp] = useState('12');
  const form = useForm<z.infer<typeof demoSchema>>({ resolver: zodResolver(demoSchema), defaultValues: { name: 'Anjali Menon', phone: '12345', notes: '', language: 'ml' } });
  useEffect(() => {
    void form.trigger('phone'); // show the inline error state
  }, [form]);
  return (
    <Block title={t('styleGuide.forms')} desc={t('styleGuide.formsDesc')}>
      <Card>
        <CardContent className="space-y-4 p-5">
          <Form {...form}>
            <form className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit(() => toast.success(t('common.saved')))} noValidate>
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel required>{t('styleGuide.fullName')}</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem><FormLabel required>{t('auth.mobile')}</FormLabel><FormControl><Input type="tel" inputMode="numeric" {...field} /></FormControl><FormDescription>{t('auth.patientHint')}</FormDescription><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="language" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('settings.language')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl><SelectTrigger><SelectValue placeholder={t('styleGuide.choose')} /></SelectTrigger></FormControl>
                    <SelectContent><SelectItem value="en">English</SelectItem><SelectItem value="ml">മലയാളം</SelectItem></SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="space-y-1.5">
                <Label htmlFor="sg-disabled">{t('styleGuide.disabled')}</Label>
                <Input id="sg-disabled" disabled value="SUN100230" readOnly />
              </div>
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem className="sm:col-span-2"><FormLabel>{t('styleGuide.notes')}</FormLabel><FormControl><Textarea placeholder={t('styleGuide.notesPh')} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="sm:col-span-2"><Button type="submit">{t('common.save')}</Button></div>
            </form>
          </Form>
          <Separator />
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('styleGuide.otp')}</p>
            <InputOTP value={otp} onChange={setOtp} label={t('auth.otpDigit')} />
          </div>
        </CardContent>
      </Card>
    </Block>
  );
}

function Choices() {
  const { t } = useTranslation();
  const [sev, setSev] = useState([4]);
  return (
    <Block title={t('styleGuide.choices')}>
      <Card>
        <CardContent className="grid gap-5 p-5 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center gap-3"><Checkbox id="c1" defaultChecked /><Label htmlFor="c1">{t('styleGuide.consentTele')}</Label></div>
            <div className="flex items-center gap-3"><Checkbox id="c2" /><Label htmlFor="c2">{t('styleGuide.consentWa')}</Label></div>
          </div>
          <RadioGroup defaultValue="video" aria-label={t('styleGuide.mode')}>
            <div className="flex items-center gap-3"><RadioGroupItem value="video" id="r1" /><Label htmlFor="r1" className="flex items-center gap-1.5"><Video className="h-4 w-4" />{t('styleGuide.video')}</Label></div>
            <div className="flex items-center gap-3"><RadioGroupItem value="audio" id="r2" /><Label htmlFor="r2" className="flex items-center gap-1.5"><Phone className="h-4 w-4" />{t('styleGuide.audio')}</Label></div>
          </RadioGroup>
          <div className="flex items-center justify-between gap-3"><Label htmlFor="sw">{t('styleGuide.whatsapp')}</Label><Switch id="sw" defaultChecked /></div>
          <div>
            <p className="text-sm font-medium">{t('styleGuide.severity')}: <b>{sev[0]}/10</b></p>
            <Slider value={sev} onValueChange={setSev} max={10} step={1} thumbLabel={t('styleGuide.severity')} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <p className="text-sm font-medium">{t('styleGuide.upload')} · 64%</p>
            <Progress value={64} aria-label={t('styleGuide.upload')} />
          </div>
        </CardContent>
      </Card>
    </Block>
  );
}

function TabsDemo() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.tabs')}>
      <Tabs defaultValue="up">
        <TabsList>
          <TabsTrigger value="up">{t('styleGuide.upcoming')}</TabsTrigger>
          <TabsTrigger value="past">{t('styleGuide.past')}</TabsTrigger>
        </TabsList>
        <TabsContent value="up"><p className="text-sm text-muted-foreground">{t('styleGuide.tabUp')}</p></TabsContent>
        <TabsContent value="past"><p className="text-sm text-muted-foreground">{t('styleGuide.tabPast')}</p></TabsContent>
      </Tabs>
    </Block>
  );
}

/* --------------------------------------------------------------- feedback */

function Feedback() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.feedback')} desc={t('styleGuide.feedbackDesc')}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <ListSkeleton rows={2} />
        <CardSkeleton />
        <Card><EmptyState art="calendar" title={t('styleGuide.emptyTitle')} body={t('styleGuide.emptyBody')} action={<Button size="sm">{t('styleGuide.findDoctor')}</Button>} /></Card>
        <div className="space-y-3">
          <Card><EmptyState art="folder" title={t('styleGuide.emptyRecords')} className="py-6" /></Card>
          <ErrorState onRetry={() => toast.message(t('common.retry'))} />
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          {(['calendar', 'folder', 'bell', 'search', 'users', 'construction'] as const).map((a) => (
            <div key={a} className="rounded-xl border bg-card"><EmptyState art={a} title={a} className="px-3 py-3 [&_h3]:text-xs" /></div>
          ))}
        </div>
        <EmergencyNotice className="sm:col-span-2" />
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button variant="outline" size="sm" onClick={() => toast.success(t('styleGuide.toastSuccess'))}>{t('styleGuide.toastSuccessBtn')}</Button>
          <Button variant="outline" size="sm" onClick={() => toast.error(t('styleGuide.toastError'))}>{t('styleGuide.toastErrorBtn')}</Button>
          <Button variant="outline" size="sm" onClick={() => toast.warning(t('styleGuide.toastWarning'))}>{t('styleGuide.toastWarningBtn')}</Button>
          <Button variant="outline" size="sm" onClick={() => toast(t('styleGuide.toastInfo'), { description: t('styleGuide.toastInfoDesc'), action: { label: t('styleGuide.undo'), onClick: () => undefined } })}>{t('styleGuide.toastInfoBtn')}</Button>
        </div>
      </div>
    </Block>
  );
}

/* ------------------------------------------------------------- navigation */

function Navigation() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.navigation')} desc={t('styleGuide.navigationDesc')}>
      <div className="space-y-4">
        <div className="overflow-hidden rounded-xl border">
          <TopBar static homeTo="/style-guide" items={PATIENT_NAV} userName="Anjali Menon" roleLabel={t('roles.patient')} notificationsCount={2} />
          <div className="bg-background p-4"><PageHeader title={t('styleGuide.pageTitle')} subtitle={t('styleGuide.pageSubtitle')} back="/style-guide" /></div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-semibold text-muted-foreground">{t('styleGuide.patientTabs')}</p>
            <div className="overflow-hidden rounded-xl border"><BottomTabBar static items={PATIENT_NAV} /></div>
            <p className="mb-1 mt-3 text-xs font-semibold text-muted-foreground">{t('styleGuide.doctorTabs')}</p>
            <div className="overflow-hidden rounded-xl border"><BottomTabBar static items={DOCTOR_NAV} /></div>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-muted-foreground">{t('styleGuide.adminSidebar')}</p>
            <div className="h-80 overflow-hidden rounded-xl border"><Sidebar items={ADMIN_NAV.slice(0, 6)} userName="Sunrise Admin" roleLabel={t('roles.admin')} /></div>
          </div>
        </div>
      </div>
    </Block>
  );
}

/* --------------------------------------------------------------- overlays */

function Overlays() {
  const { t } = useTranslation();
  return (
    <Block title={t('styleGuide.overlays')} desc={t('styleGuide.overlaysDesc')}>
      <div className="flex flex-wrap gap-2">
        <Dialog>
          <DialogTrigger asChild><Button variant="outline">{t('styleGuide.openDialog')}</Button></DialogTrigger>
          <DialogContent closeLabel={t('common.close')}>
            <DialogHeader>
              <DialogTitle>{t('styleGuide.dialogTitle')}</DialogTitle>
              <DialogDescription>{t('styleGuide.dialogDesc')}</DialogDescription>
            </DialogHeader>
            <DialogFooter><Button variant="ghost">{t('common.cancel')}</Button><Button variant="destructive">{t('styleGuide.confirmCancel')}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger asChild><Button variant="outline">{t('styleGuide.openSheet')}</Button></SheetTrigger>
          <SheetContent side="bottom" closeLabel={t('common.close')} className="sm:mx-auto sm:max-w-lg sm:rounded-t-3xl">
            <SheetHeader>
              <SheetTitle>{t('styleGuide.sheetTitle')}</SheetTitle>
              <SheetDescription>{t('styleGuide.sheetDesc')}</SheetDescription>
            </SheetHeader>
            <Button block className="mt-4">{t('styleGuide.primary')}</Button>
          </SheetContent>
        </Sheet>
        <Tooltip>
          <TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={t('styleGuide.tooltipBtn')}><Bell /></Button></TooltipTrigger>
          <TooltipContent>{t('styleGuide.tooltip')}</TooltipContent>
        </Tooltip>
      </div>
    </Block>
  );
}

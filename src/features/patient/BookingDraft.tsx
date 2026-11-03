import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ConsultMode, MedicalDocument } from '@/domain/types';
import type { SymptomPayload } from './api';

/**
 * In-memory booking draft (doctor → slot → pre-consult form → hold → review).
 * Kept in React state only – symptoms are never written to localStorage / sessionStorage.
 */
export interface BookingDraft {
  doctorId: string;
  doctorName: string;
  patientId: string;
  slotId: string;
  slotStart: string;
  mode: ConsultMode;
  symptoms?: SymptomPayload;
  documents: MedicalDocument[];
  /** Appointment id of the current hold, so going back can release it. */
  heldAppointmentId?: string;
}

interface Ctx {
  draft: BookingDraft | null;
  start: (d: Omit<BookingDraft, 'documents'>) => void;
  update: (patch: Partial<BookingDraft>) => void;
  clear: () => void;
}

const BookingCtx = createContext<Ctx | null>(null);

export function BookingDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const start = useCallback((d: Omit<BookingDraft, 'documents'>) => {
    // keep what was typed / uploaded when the same patient picks another slot
    setDraft((prev) => ({ ...d, documents: prev?.patientId === d.patientId ? prev.documents : [], symptoms: prev?.patientId === d.patientId ? prev.symptoms : undefined }));
  }, []);
  const update = useCallback((patch: Partial<BookingDraft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev)), []);
  const clear = useCallback(() => setDraft(null), []);
  const value = useMemo(() => ({ draft, start, update, clear }), [draft, start, update, clear]);
  return <BookingCtx.Provider value={value}>{children}</BookingCtx.Provider>;
}

export function useBookingDraft() {
  const c = useContext(BookingCtx);
  if (!c) throw new Error('BookingDraftProvider missing');
  return c;
}

import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import { isPhotoFile, preparePhotoForUpload } from './couplePhotoService';
import type { VisitMemoryEntry } from '../types/database';

export const VISIT_MEMORIES_BUCKET = 'visit-memories';
export const VISIT_MEMORY_NOTE_MAX = 240;
export const VISIT_MEMORY_URL_TTL_SECONDS = 60 * 60;
export const VISIT_MEMORY_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const VISIT_MEMORY_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function storageApi() {
  const client = requireSupabase() as unknown as { storage?: { from: (bucket: string) => unknown } };
  if (!client.storage) throw new Error('Photo storage is unavailable right now.');
  return client.storage.from(VISIT_MEMORIES_BUCKET) as {
    upload: (path: string, body: Blob, options?: { contentType?: string; upsert?: boolean }) => Promise<{ error: { message: string } | null }>;
    remove: (paths: string[]) => Promise<{ error: { message: string } | null }>;
    createSignedUrl: (path: string, ttl: number) => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
  };
}

function imageExtension(type: string): string {
  switch (type.toLowerCase()) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    default: return 'jpg';
  }
}

export function visitMemoryStoragePath(coupleId: string, userId: string, visitId: string, extension = 'jpg'): string {
  return `memories/${coupleId}/${userId}/${visitId}/${crypto.randomUUID()}.${extension}`;
}

async function removeFile(path: string | null | undefined) {
  if (!path) return;
  try { await storageApi().remove([path]); } catch { /* orphan cleanup must never break a saved memory */ }
}

export async function fetchVisitMemories(coupleId: string): Promise<VisitMemoryEntry[]> {
  const { data, error } = await requireSupabase().from('visit_memory_entries')
    .select('*').eq('couple_id', coupleId).order('created_at', { ascending: false });
  if (error) throw new Error(describeDatabaseError(error));
  const entries = (data as VisitMemoryEntry[]) || [];
  return Promise.all(entries.map(async (entry) => {
    try {
      const { data: signed, error: signedError } = await storageApi().createSignedUrl(entry.photo_path, VISIT_MEMORY_URL_TTL_SECONDS);
      return { ...entry, photo_url: signedError ? null : signed?.signedUrl ?? null };
    } catch {
      return { ...entry, photo_url: null };
    }
  }));
}

export async function saveVisitMemory(input: {
  coupleId: string;
  userId: string;
  visitId: string;
  file: Blob | null;
  note: string;
  existing?: VisitMemoryEntry | null;
}): Promise<VisitMemoryEntry> {
  const note = input.note.trim();
  if (!note) throw new Error('Add one line about your best moment.');
  if (note.length > VISIT_MEMORY_NOTE_MAX) throw new Error(`Keep the memory under ${VISIT_MEMORY_NOTE_MAX} characters.`);
  if (input.file && (!isPhotoFile(input.file) || !VISIT_MEMORY_MIME_TYPES.has(input.file.type.toLowerCase()))) {
    throw new Error('Choose a JPEG, PNG, WebP or HEIC photo for your memory.');
  }
  if (!input.file && !input.existing?.photo_path) throw new Error('Choose one photo from your visit.');

  let photoPath = input.existing?.photo_path ?? '';
  let uploadedPath: string | null = null;
  if (input.file) {
    const prepared = await preparePhotoForUpload(input.file);
    if (prepared.size > VISIT_MEMORY_MAX_UPLOAD_BYTES) {
      throw new Error('That photo is still too large after resizing. Please choose one under 10 MB.');
    }
    const extension = imageExtension(prepared.type || input.file.type);
    uploadedPath = visitMemoryStoragePath(input.coupleId, input.userId, input.visitId, extension);
    const { error } = await storageApi().upload(uploadedPath, prepared, {
      contentType: prepared.type || input.file.type || 'image/jpeg',
      upsert: false,
    });
    if (error) throw new Error(describeDatabaseError(error));
    photoPath = uploadedPath;
  }

  const { data, error } = await requireSupabase().from('visit_memory_entries').upsert({
    couple_id: input.coupleId,
    visit_id: input.visitId,
    user_id: input.userId,
    photo_path: photoPath,
    note,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'visit_id,user_id' }).select('*').single();
  if (error || !data) {
    await removeFile(uploadedPath);
    throw new Error(error ? describeDatabaseError(error) : 'Your memory could not be saved.');
  }

  if (input.existing?.photo_path && input.existing.photo_path !== photoPath) {
    await removeFile(input.existing.photo_path);
  }
  let photoUrl: string | null = null;
  try {
    const { data: signed } = await storageApi().createSignedUrl(photoPath, VISIT_MEMORY_URL_TTL_SECONDS);
    photoUrl = signed?.signedUrl ?? null;
  } catch { /* saved entry stays available even if its photo URL needs a later refresh */ }
  return { ...(data as VisitMemoryEntry), photo_url: photoUrl };
}

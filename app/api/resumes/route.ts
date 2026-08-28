import { NextResponse } from "next/server";

import { requireSession, UnauthorizedError } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  createResume,
  listResumesForUser,
  ResumeQueryError,
} from "@/lib/supabase/queries/resumes";
import {
  deleteResumeFile,
  extractResumeText,
  uploadResumeFile,
} from "@/lib/storage/resumeFiles";
import { resumeUploadFileSchema } from "@/lib/validation/schemas";
import { toResumeListItem } from "@/types/domain";

/**
 * GET /api/resumes — list the caller's own resumes.
 * Response shape/ordering per docs/ARCHITECTURE.md §2.
 */
export async function GET() {
  try {
    const { user } = await requireSession();
    const supabase = await createClient();

    const resumes = await listResumesForUser(supabase, user.id);

    return NextResponse.json({ resumes: resumes.map(toResumeListItem) });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    console.error(
      "GET /api/resumes failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to list resumes." },
      { status: 500 },
    );
  }
}

/**
 * POST /api/resumes — upload a resume file.
 * Behavior/response/error shapes per docs/ARCHITECTURE.md §2 and the
 * resolved decisions in §5 (accepted types, 5MB cap, synchronous text
 * extraction at upload time for this milestone).
 */
export async function POST(request: Request) {
  let user;
  try {
    ({ user } = await requireSession());
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with a `file` field." },
      { status: 400 },
    );
  }

  const parsedFile = resumeUploadFileSchema.safeParse(formData.get("file"));
  if (!parsedFile.success) {
    return NextResponse.json(
      { error: parsedFile.error.issues[0]?.message ?? "Invalid file." },
      { status: 400 },
    );
  }

  const file = parsedFile.data;
  const buffer = Buffer.from(await file.arrayBuffer());

  const supabase = await createClient();

  let storageResult;
  try {
    storageResult = await uploadResumeFile(supabase, {
      userId: user.id,
      fileType: file.type,
      buffer,
    });
  } catch (err) {
    console.error(
      "POST /api/resumes: upload to Storage failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Failed to store resume file." },
      { status: 500 },
    );
  }

  // Extract text synchronously at upload time (per docs/ARCHITECTURE.md §5).
  // A failure here is not fatal to the upload — the row is created with
  // `extracted_text: null` and can be re-extracted later when `/analyze`
  // ships (M3). Never log file content, only the error message.
  let extractedText: string | null = null;
  try {
    extractedText = await extractResumeText(file.type, buffer);
  } catch (err) {
    console.error(
      "POST /api/resumes: text extraction failed, continuing with extracted_text=null:",
      err instanceof Error ? err.message : "unknown error",
    );
  }

  try {
    const resume = await createResume(supabase, {
      id: storageResult.resumeId,
      userId: user.id,
      storagePath: storageResult.storagePath,
      fileName: file.name,
      fileType: file.type,
      fileSizeBytes: file.size,
      extractedText,
    });

    return NextResponse.json(
      { resume: toResumeListItem(resume) },
      { status: 201 },
    );
  } catch (err) {
    // Roll back the now-orphaned Storage object since no row exists to
    // reference it.
    await deleteResumeFile(supabase, storageResult.storagePath).catch(
      (cleanupErr) => {
        console.error(
          "POST /api/resumes: failed to roll back orphaned Storage object after DB insert failure:",
          cleanupErr instanceof Error ? cleanupErr.message : "unknown error",
        );
      },
    );

    const message =
      err instanceof ResumeQueryError ? err.message : "unknown error";
    console.error("POST /api/resumes: failed to save resume row:", message);

    return NextResponse.json(
      { error: "Failed to save resume." },
      { status: 500 },
    );
  }
}

// Unit tests for the public intake form's real-storage upload flow
// (Priority 1a, docs/migrations/2026-08-12-job-media-storage-bucket.sql).
// Before this fix, handleFile only ever created a browser-local blob URL
// via URL.createObjectURL() and handleSubmit sent {name, type} metadata
// with no file behind it -- these tests exist specifically to catch a
// regression back to that state. Network (fetch to /api/review-job) and
// Supabase (rpc + storage) are fully mocked; no request leaves the process.
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ScopeIntake from './ScopeIntake.jsx';
import { mockSupabase, resetSupabaseMock, setRpcResponse, storageBucketMock } from './test/mocks/supabaseMock.js';

vi.mock('./supabaseClient.js', async () => {
  const { mockSupabase } = await import('./test/mocks/supabaseMock.js');
  return { supabase: mockSupabase };
});

const JOB = { id: 'job-123', company_id: 'company-abc' };

beforeEach(() => {
  resetSupabaseMock();
  setRpcResponse('submit_public_job', { data: JOB, error: null });
  setRpcResponse('attach_job_media', { data: null, error: null });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: async () => ({
      jobType: 'Leaking pipe',
      urgency: 'Medium',
      likelyMaterials: [],
      briefSummary: 'Test summary',
      watchOutFor: 'Nothing notable',
    }),
  }));
});

// Drives the whole 9-step flow. Steps have no accessible labels (tracked
// separately in the frontend audit -- item 3d), so fields are queried by
// DOM position/type, same pattern already used in Join.test.jsx/
// Login.test.jsx for this app's unlabeled forms.
async function fillAndSubmit(user, { attachFile } = {}) {
  // 1. context (textarea)
  await user.type(document.querySelector('textarea'), 'Water pooling under the sink');
  await user.click(screen.getByRole('button', { name: /next/i }));

  // 2. contact
  const [nameInput, phoneInput] = document.querySelectorAll('input[type="text"], input[type="tel"]');
  await user.type(nameInput, 'Jamie Customer');
  await user.type(phoneInput, '5551234567');
  await user.click(screen.getByRole('button', { name: /next/i }));

  // 3. media (optional)
  if (attachFile) {
    const fileInput = document.querySelector('input[type="file"]');
    await user.upload(fileInput, attachFile);
  }
  await user.click(screen.getByRole('button', { name: /next/i }));

  // 4. fixture (text)
  await user.type(document.querySelector('input[type="text"]'), 'Moen, brushed nickel');
  await user.click(screen.getByRole('button', { name: /next/i }));

  // 5. pipe (choice)
  await user.click(screen.getByRole('button', { name: 'Copper' }));
  await user.click(screen.getByRole('button', { name: /next/i }));

  // 6. access (textarea)
  await user.type(document.querySelector('textarea'), 'Gate code 1234');
  await user.click(screen.getByRole('button', { name: /next/i }));

  // 7. cutting (choice)
  await user.click(screen.getByRole('button', { name: /go ahead if needed/i }));
  await user.click(screen.getByRole('button', { name: /next/i }));

  // 8. preference (choice)
  await user.click(screen.getByRole('button', { name: /whatever you recommend/i }));
  await user.click(screen.getByRole('button', { name: /next/i }));

  // 9. leak_detection (choice) -- last step, advancing submits.
  await user.click(screen.getByRole('button', { name: /not applicable/i }));
  await user.click(screen.getByRole('button', { name: /submit job request/i }));
}

describe('ScopeIntake media upload', () => {
  it('uploads an attached file to Supabase Storage and links it to the job via attach_job_media', async () => {
    const user = userEvent.setup();
    const file = new File(['fake-image-bytes'], 'leak.jpg', { type: 'image/jpeg' });
    render(<ScopeIntake />);

    await fillAndSubmit(user, { attachFile: file });

    await waitFor(() => expect(screen.getByText(/job brief/i)).toBeInTheDocument());

    // Uploaded under {company_id}/{job_id}/... -- never guessed client-side,
    // both values came straight from submit_public_job's response.
    expect(mockSupabase.storage.from).toHaveBeenCalledWith('job-media');
    expect(storageBucketMock.upload).toHaveBeenCalledTimes(1);
    const [path, uploadedFile] = storageBucketMock.upload.mock.calls[0];
    expect(path.startsWith(`${JOB.company_id}/${JOB.id}/`)).toBe(true);
    expect(path).toContain('leak.jpg');
    expect(uploadedFile).toBe(file);

    // The real path (not just {name, type}) gets attached to the job row.
    expect(mockSupabase.rpc).toHaveBeenCalledWith('attach_job_media', expect.objectContaining({
      p_job_id: JOB.id,
      p_media: [expect.objectContaining({ name: 'leak.jpg', type: 'image', path })],
    }));

    // No partial-failure warning when everything succeeded.
    expect(screen.queryByText(/didn't upload/i)).not.toBeInTheDocument();
  });

  it('does not block the job save when a media upload fails, and surfaces it instead of silently dropping it', async () => {
    storageBucketMock.upload.mockResolvedValueOnce({ data: null, error: { message: 'network error' } });
    const user = userEvent.setup();
    const file = new File(['fake-image-bytes'], 'leak.jpg', { type: 'image/jpeg' });
    render(<ScopeIntake />);

    await fillAndSubmit(user, { attachFile: file });

    // The job itself still saved -- success screen, not an error state.
    await waitFor(() => expect(screen.getByText(/job brief/i)).toBeInTheDocument());
    expect(mockSupabase.rpc).toHaveBeenCalledWith('submit_public_job', expect.objectContaining({ p_media: [] }));

    // A failed upload means nothing to attach -- attach_job_media shouldn't
    // even be called (there'd be nothing real to link).
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('attach_job_media', expect.anything());

    // Customer is told the attachment didn't make it, not left thinking
    // everything came through.
    expect(await screen.findByText(/didn't upload/i)).toBeInTheDocument();
  });

  it('does not attempt any upload when no file was attached', async () => {
    const user = userEvent.setup();
    render(<ScopeIntake />);

    await fillAndSubmit(user, {});

    await waitFor(() => expect(screen.getByText(/job brief/i)).toBeInTheDocument());
    expect(storageBucketMock.upload).not.toHaveBeenCalled();
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('attach_job_media', expect.anything());
    expect(screen.queryByText(/didn't upload/i)).not.toBeInTheDocument();
  });
});

// Covers the fix for a real gap: submit_public_job() rejecting used to be
// swallowed by a bare console.error, leaving the customer looking at the
// full "job brief -- ready for dispatch" screen for a job that was never
// actually saved (see docs/audits/2026-08-08-migration-safety-playbook.md's
// complexity-debt audit, tech-debt finding 3.1). These tests exist to catch
// a regression back to that silent-failure state.
describe('ScopeIntake submission failure + retry', () => {
  it('does not show the job brief when submit_public_job fails, and tells the customer instead', async () => {
    mockSupabase.rpc.mockImplementationOnce(() =>
      Promise.resolve({ data: null, error: { message: 'network error' } })
    );
    const user = userEvent.setup();
    render(<ScopeIntake />);

    await fillAndSubmit(user, {});

    expect(await screen.findByText(/couldn't save your request/i)).toBeInTheDocument();
    expect(screen.queryByText(/job brief/i)).not.toBeInTheDocument();
  });

  it('retries the save using the already-computed brief, without calling /api/review-job again', async () => {
    mockSupabase.rpc.mockImplementationOnce(() =>
      Promise.resolve({ data: null, error: { message: 'network error' } })
    );
    const user = userEvent.setup();
    render(<ScopeIntake />);

    await fillAndSubmit(user, {});
    expect(await screen.findByText(/couldn't save your request/i)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // beforeEach's default RPC config (success) is back in effect now that
    // the one-time failure override above has been consumed.
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText(/job brief/i)).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledTimes(1); // still 1 -- no second AI call
    expect(mockSupabase.rpc).toHaveBeenCalledWith('submit_public_job', expect.objectContaining({
      p_ai_job_type: 'Leaking pipe', // the brief from the original (only) fetch call
    }));
  });

  it('"Start over instead" resets back to the first step', async () => {
    mockSupabase.rpc.mockImplementationOnce(() =>
      Promise.resolve({ data: null, error: { message: 'network error' } })
    );
    const user = userEvent.setup();
    render(<ScopeIntake />);

    await fillAndSubmit(user, {});
    expect(await screen.findByText(/couldn't save your request/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /start over instead/i }));

    expect(screen.getByText(/step 1 of/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't save your request/i)).not.toBeInTheDocument();
  });
});

// Client-side input limits (Tier 2 #9, docs/scope-operational-playbook.md).
// These mirror the server-side/DB limits (api/review-job.js,
// docs/migrations/2026-08-15-add-input-limits.sql) so a customer gets a
// clear, friendly message at the moment they type too much or pick a bad
// file, instead of a rejection deep inside a later network call.
function makeFileOfSize(name, type, sizeBytes) {
  const file = new File(['x'], name, { type });
  // File's real size is derived from its content; overriding the `size`
  // getter is the standard jsdom-safe way to simulate a large file without
  // actually allocating that many bytes in the test.
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

async function goToMediaStep(user) {
  await user.type(document.querySelector('textarea'), 'Water pooling under the sink');
  await user.click(screen.getByRole('button', { name: /next/i }));
  const [nameInput, phoneInput] = document.querySelectorAll('input[type="text"], input[type="tel"]');
  await user.type(nameInput, 'Jamie Customer');
  await user.type(phoneInput, '5551234567');
  await user.click(screen.getByRole('button', { name: /next/i }));
}

describe('ScopeIntake client-side input limits', () => {
  it('enforces maxLength on the context/access textareas and contact fields', async () => {
    const user = userEvent.setup();
    render(<ScopeIntake />);

    expect(document.querySelector('textarea')).toHaveAttribute('maxLength', '2000');

    await goToMediaStep(user);
    await user.click(screen.getByRole('button', { name: /next/i })); // past media, to fixture
    const fixtureInput = document.querySelector('input[type="text"]');
    expect(fixtureInput).toHaveAttribute('maxLength', '500'); // fixture
    await user.type(fixtureInput, 'Moen'); // required to enable Next
    await user.click(screen.getByRole('button', { name: /next/i })); // past fixture, to pipe
    await user.click(screen.getByRole('button', { name: 'Copper' }));
    await user.click(screen.getByRole('button', { name: /next/i })); // to access
    expect(document.querySelector('textarea')).toHaveAttribute('maxLength', '2000'); // access
  });

  it('has maxLength set on the contact name/phone/email inputs', async () => {
    const user = userEvent.setup();
    render(<ScopeIntake />);
    await user.type(document.querySelector('textarea'), 'Water pooling under the sink');
    await user.click(screen.getByRole('button', { name: /next/i }));

    const [nameInput, phoneInput, emailInput] = document.querySelectorAll(
      'input[type="text"], input[type="tel"], input[type="email"]'
    );
    expect(nameInput).toHaveAttribute('maxLength', '200');
    expect(phoneInput).toHaveAttribute('maxLength', '30');
    expect(emailInput).toHaveAttribute('maxLength', '320');
  });

  it('rejects an oversized file with a friendly inline message and does not attach it', async () => {
    const user = userEvent.setup();
    render(<ScopeIntake />);
    await goToMediaStep(user);

    const bigFile = makeFileOfSize('huge.jpg', 'image/jpeg', 26 * 1024 * 1024);
    const fileInput = document.querySelector('input[type="file"]');
    await user.upload(fileInput, bigFile);

    expect(await screen.findByText(/over the 25 MB limit/i)).toBeInTheDocument();
    // Not added to the attachment preview grid.
    expect(screen.queryByAltText(/uploaded photo/i)).not.toBeInTheDocument();
  });

  it('rejects an unsupported file type with a friendly inline message', async () => {
    const user = userEvent.setup();
    render(<ScopeIntake />);
    await goToMediaStep(user);

    // The file input's `accept="image/*,video/*"` already steers a real OS
    // picker away from non-media files (and user-event's own upload()
    // enforces that same filter, so it can't be used to simulate this
    // case) -- but `accept` is only ever a UI hint, not a guarantee (some
    // mobile pickers and all drag-and-drop ignore it), so handleFile has
    // to check the actual file type itself. Firing the change event
    // directly bypasses user-event's accept filtering to exercise exactly
    // that server-can't-trust-the-picker path.
    const badFile = new File(['not-a-photo'], 'notes.txt', { type: 'text/plain' });
    const fileInput = document.querySelector('input[type="file"]');
    Object.defineProperty(fileInput, 'files', { value: [badFile], configurable: true });
    fireEvent.change(fileInput);

    expect(await screen.findByText(/supported photo\/video type/i)).toBeInTheDocument();
  });

  it('caps total attachments at 8 and tells the customer how many were skipped', async () => {
    const user = userEvent.setup();
    render(<ScopeIntake />);
    await goToMediaStep(user);

    const fileInput = document.querySelector('input[type="file"]');
    const nineFiles = Array.from({ length: 9 }, (_, i) =>
      new File(['x'], `photo${i}.jpg`, { type: 'image/jpeg' })
    );
    await user.upload(fileInput, nineFiles);

    expect(await screen.findByText(/only 8 attachments are allowed/i)).toBeInTheDocument();
    expect(screen.getAllByAltText(/uploaded photo/i)).toHaveLength(8);
  });

  it('accepts a good file with no error message shown', async () => {
    const user = userEvent.setup();
    render(<ScopeIntake />);
    await goToMediaStep(user);

    const goodFile = new File(['fake-image-bytes'], 'leak.jpg', { type: 'image/jpeg' });
    const fileInput = document.querySelector('input[type="file"]');
    await user.upload(fileInput, goodFile);

    expect(await screen.findByAltText(/uploaded photo 1/i)).toBeInTheDocument();
    expect(screen.queryByText(/25 MB limit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/supported photo\/video type/i)).not.toBeInTheDocument();
  });
});

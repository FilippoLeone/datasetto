import { describe, expect, it } from 'vitest';
import { addFiles, attachmentIds, attachmentSummary, canSend, filesFromTransfer, isAcceptedImage, removeDraft, transferHasFiles, updateDraft, type AttachmentDraft } from './attachments';
import type { Attachment } from '@/types/protocol';

const limits = { maxBytes: 1024, maxFiles: 3, acceptedTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] };
const file = (name: string, type: string, size = 10): File => new File([new Uint8Array(size)], name, { type });
const url = (f: File) => 'blob:' + f.name;
const attachment = (id: string): Attachment => ({ id, kind: 'image', fileName: id + '.png', mime: 'image/png', size: 1, width: 1, height: 1, url: '/api/uploads/' + id + '.png', previewUrl: '/api/uploads/' + id + '.preview.webp', previewWidth: 1, previewHeight: 1 });

describe('composer attachments', () => {
  it('summarises what a message without text carries', () => {
    expect(attachmentSummary(undefined)).toBe('');
    expect(attachmentSummary([])).toBe('');
    expect(attachmentSummary([{ kind: 'image' }])).toBe('Sent a picture');
    expect(attachmentSummary([{ kind: 'video' }])).toBe('Sent a video');
    expect(attachmentSummary([{ kind: 'image' }, { kind: 'image' }])).toBe('Sent 2 pictures');
    expect(attachmentSummary([{ kind: 'video' }, { kind: 'video' }, { kind: 'video' }])).toBe('Sent 3 videos');
    expect(attachmentSummary([{ kind: 'image' }, { kind: 'video' }])).toBe('Sent 2 files');
  });

  it('accepts pictures by type, or by extension when the browser reports none', () => {
    expect(isAcceptedImage(file('a.png', 'image/png'), limits.acceptedTypes)).toBe(true);
    expect(isAcceptedImage(file('a.PNG', 'IMAGE/PNG'), limits.acceptedTypes)).toBe(true);
    expect(isAcceptedImage(file('a.jpg', ''), limits.acceptedTypes)).toBe(true);
    expect(isAcceptedImage(file('a.JPEG', ''), limits.acceptedTypes)).toBe(true);
    expect(isAcceptedImage(file('a.svg', 'image/svg+xml'), limits.acceptedTypes)).toBe(false);
    expect(isAcceptedImage(file('a.png', 'text/plain'), limits.acceptedTypes)).toBe(false);
    expect(isAcceptedImage(file('notes', ''), limits.acceptedTypes)).toBe(false);
  });

  it('adds what fits and explains the rest', () => {
    const result = addFiles([], [file('one.png', 'image/png'), file('doc.pdf', 'application/pdf'), file('big.jpg', 'image/jpeg', 2048), file('empty.gif', 'image/gif', 0), file('two.webp', 'image/webp'), file('three.png', 'image/png'), file('four.png', 'image/png')], limits, url);
    expect(result.drafts.map((draft) => draft.file.name)).toEqual(['one.png', 'two.webp', 'three.png']);
    expect(result.drafts.map((draft) => [draft.status, draft.progress, draft.previewUrl, draft.attachment])).toEqual([
      ['uploading', 0, 'blob:one.png', null],
      ['uploading', 0, 'blob:two.webp', null],
      ['uploading', 0, 'blob:three.png', null],
    ]);
    expect(result.rejected.map((entry) => [entry.file.name, entry.reason])).toEqual([
      ['doc.pdf', 'Only PNG, JPEG, WebP and GIF pictures can be shared'],
      ['big.jpg', 'Pictures must be 0.0 MB or smaller'],
      ['empty.gif', 'The file is empty'],
      ['four.png', 'At most 3 pictures per message'],
    ]);
    expect(new Set(result.drafts.map((draft) => draft.key)).size).toBe(3);
    // Existing drafts count against the cap and are kept in front.
    const more = addFiles(result.drafts, [file('five.png', 'image/png')], limits, url);
    expect(more.drafts).toHaveLength(3);
    expect(more.rejected[0].reason).toBe('At most 3 pictures per message');
    expect(addFiles([], [file('a.png', 'image/png', 10 * 1024 * 1024 + 1)], { ...limits, maxBytes: 10 * 1024 * 1024 }, url).rejected[0].reason).toBe('Pictures must be 10 MB or smaller');
  });

  it('tracks upload state and decides when a message can go out', () => {
    let drafts: AttachmentDraft[] = addFiles([], [file('a.png', 'image/png'), file('b.png', 'image/png')], limits, url).drafts;
    expect(canSend('', drafts)).toBe(false);
    expect(canSend('hello', drafts)).toBe(false);
    drafts = updateDraft(drafts, drafts[0].key, { progress: 0.5 });
    expect(drafts[0].progress).toBe(0.5);
    drafts = updateDraft(drafts, drafts[0].key, { status: 'ready', progress: 1, attachment: attachment('att-a') });
    drafts = updateDraft(drafts, drafts[1].key, { status: 'error', error: 'nope' });
    expect(canSend('hello', drafts)).toBe(false);
    drafts = removeDraft(drafts, drafts[1].key);
    expect(drafts).toHaveLength(1);
    expect(canSend('', drafts)).toBe(true);
    expect(canSend('   ', drafts)).toBe(true);
    expect(attachmentIds(drafts)).toEqual(['att-a']);
    expect(canSend('', [])).toBe(false);
    expect(canSend('text', [])).toBe(true);
    expect(removeDraft(drafts, 'missing')).toEqual(drafts);
  });

  it('reads files out of a paste or drop', () => {
    const png = file('shot.png', 'image/png');
    const items = [
      { kind: 'file', getAsFile: () => png },
      { kind: 'string', getAsFile: () => null },
    ];
    const transfer = { items, files: [], types: ['Files'] } as unknown as DataTransfer;
    expect(filesFromTransfer(transfer)).toEqual([png]);
    expect(transferHasFiles(transfer)).toBe(true);
    const plain = { items: [{ kind: 'string', getAsFile: () => null }], files: [png], types: ['text/plain'] } as unknown as DataTransfer;
    expect(filesFromTransfer(plain)).toEqual([png]);
    expect(transferHasFiles(plain)).toBe(false);
    expect(filesFromTransfer(null)).toEqual([]);
    expect(transferHasFiles(undefined)).toBe(false);
  });
});

import 'server-only';
import { canvaApi, config } from '@/lib/canva';

function clean(value, max = 255) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
export function safeId(value, field = 'ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid Canva ${field}.`);
  return value;
}
function positiveInt(value, max) { return Math.min(Math.max(Number.parseInt(value, 10) || 20, 1), max); }
function checkType(type) {
  if (!['doc', 'presentation', 'whiteboard', 'email'].includes(type)) throw new Error('Invalid Canva preset type.');
  return type;
}
export function designSummary(design) {
  if (!design) return null;
  return { id: design.id, title: design.title || 'Untitled design',
    editUrl: design.urls?.edit_url || (design.id ? `https://www.canva.com/design/${encodeURIComponent(design.id)}/edit` : ''),
    viewUrl: design.urls?.view_url || '', updatedAt: design.updated_at || null,
    type: design.design_types?.[0] || 'custom', thumbnail: design.thumbnail?.url || '', pageCount: design.page_count || null };
}
export async function listDesigns(uid, { query = '', limit = 20, continuation = '' } = {}) {
  const result = await canvaApi(uid, 'designs', {
    query: { query: clean(query, 255), continuation: clean(continuation, 1000), limit: positiveInt(limit, 50), sort_by: 'modified_descending' }
  });
  return { items: (result.items || []).map(designSummary), continuation: result.continuation || '' };
}
export async function getDesign(uid, designId) {
  const result = await canvaApi(uid, `designs/${safeId(designId, 'design ID')}`);
  return designSummary(result.design);
}
export function designBody({ title, type = 'custom', width = 1080, height = 1080, assetId } = {}) {
  const name = clean(title, 255);
  if (!name) throw new Error('Design title is required.');
  let design_type;
  if (type === 'custom') {
    const w = Number(width), h = Number(height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 40 || h < 40 || w > 8000 || h > 8000 || w * h > 25_000_000) {
      throw new Error('Canva custom size must be 40–8000 px each, with an area under 25 million pixels.');
    }
    design_type = { type: 'custom', width: w, height: h };
  } else design_type = { type: 'preset', name: checkType(type) };
  return { type: 'type_and_asset', design_type, title: name,
    ...(assetId ? { asset_id: safeId(assetId, 'asset ID') } : {}) };
}
export async function createDesign(uid, args) {
  const result = await canvaApi(uid, 'designs', { method: 'POST', body: designBody(args) });
  return designSummary(result.design);
}
export async function startExport(uid, { designId, format = 'png' } = {}) {
  const id = safeId(designId, 'design ID');
  const formats = new Set(['png', 'jpg', 'pdf', 'pptx', 'mp4', 'gif', 'csv']);
  if (!formats.has(format)) throw new Error('Unsupported export format.');
  const exportFormat = format === 'jpg' ? { type: 'jpg', quality: 85 } :
    format === 'mp4' ? { type: 'mp4', quality: 'horizontal_720p' } : { type: format };
  return canvaApi(uid, 'exports', { method: 'POST', body: { design_id: id, format: exportFormat } });
}
export async function getExport(uid, jobId) {
  const result = await canvaApi(uid, `exports/${safeId(jobId, 'export job ID')}`);
  const j = result.job || {};
  return { id: j.id, status: j.status, urls: j.urls || [], error: j.error?.code || '' };
}
export async function listFolder(uid, { folderId = 'root', limit = 30, continuation = '' } = {}) {
  const result = await canvaApi(uid, `folders/${safeId(folderId, 'folder ID')}/items`, {
    query: { limit: positiveInt(limit, 50), continuation: clean(continuation, 1000) }
  });
  return { items: (result.items || []).map(item => {
    const data = item[item.type] || {};
    return { type: item.type, id: data.id || item.id || '', name: data.name || data.title || '',
      editUrl: data.urls?.edit_url || '' };
  }), continuation: result.continuation || '' };
}
export async function createFolder(uid, { name, parentFolderId = 'root' } = {}) {
  const label = clean(name, 255);
  if (!label) throw new Error('Folder name is required.');
  return canvaApi(uid, 'folders', { method: 'POST', body: { name: label, parent_folder_id: safeId(parentFolderId, 'parent folder ID') } });
}
export async function getAsset(uid, assetId) {
  const result = await canvaApi(uid, `assets/${safeId(assetId, 'asset ID')}`);
  return result.asset || {};
}
export async function listBrandTemplates(uid, query = '') {
  return canvaApi(uid, 'brand-templates', { query: { query: clean(query, 255) } });
}
export async function getBrandTemplate(uid, id) {
  return canvaApi(uid, `brand-templates/${safeId(id, 'brand template ID')}`);
}
export async function getCapabilities(uid) { return canvaApi(uid, 'users/me/capabilities'); }

export async function renameFolder(uid, { folderId, name } = {}) {
  const id = safeId(folderId, 'folder ID');
  if (id === 'root' || id === 'uploads') throw new Error('Cannot rename a Canva system folder.');
  const title = clean(name, 255);
  if (!title) throw new Error('Folder name is required.');
  return canvaApi(uid, `folders/${id}`, { method: 'PATCH', body: { name: title } });
}
export async function deleteFolder(uid, folderId) {
  const id = safeId(folderId, 'folder ID');
  if (id === 'root' || id === 'uploads') throw new Error('Cannot delete a Canva system folder.');
  await canvaApi(uid, `folders/${id}`, { method: 'DELETE' });
  return { deleted: true, folderId: id };
}
export function publicAssetUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid asset URL.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Asset must be a public HTTPS URL.'); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
    !host.includes('.') || /(^|\.)(localhost|local|internal|test)$/.test(host) ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':') || host.endsWith('.localhost')) {
    throw new Error('Asset must be a public HTTPS URL.');
  }
  return parsed.toString();
}
export async function uploadAssetFromUrl(uid, { name, url } = {}) {
  const title = clean(name, 255);
  if (!title) throw new Error('Asset name is required.');
  return canvaApi(uid, 'url-asset-uploads', { method: 'POST', body: { name: title, url: publicAssetUrl(url) } });
}
export async function getAssetUpload(uid, jobId) {
  return canvaApi(uid, `url-asset-uploads/${safeId(jobId, 'upload job ID')}`);
}
export async function updateAsset(uid, { assetId, name, tags } = {}) {
  const body = {};
  if (name !== undefined) body.name = clean(name, 50);
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > 50 || tags.some(t => typeof t !== 'string' || t.length > 50)) throw new Error('Invalid asset tags.');
    body.tags = tags;
  }
  if (!Object.keys(body).length) throw new Error('Specify a new asset name or tags.');
  return canvaApi(uid, `assets/${safeId(assetId, 'asset ID')}`, { method: 'PATCH', body });
}
export async function deleteAsset(uid, assetId) {
  const id = safeId(assetId, 'asset ID');
  await canvaApi(uid, `assets/${id}`, { method: 'DELETE' });
  return { deleted: true, assetId: id };
}
export async function commentOnDesign(uid, { designId, message } = {}) {
  const text = clean(message, 2048);
  if (!text) throw new Error('Comment text is required.');
  if (!config().previewComments) throw new Error('Canva comment API is preview-only and disabled on this deployment.');
  return canvaApi(uid, `designs/${safeId(designId, 'design ID')}/comments`, {
    method: 'POST', body: { message_plaintext: text }
  });
}

// Canva's text-to-design generation endpoint is preview-only as of Nov 2026.
// Do not enable for public apps unless Canva has approved use of this preview API.
export async function generateDesign(uid, { brief, type = 'presentation' } = {}) {
  if (!config().previewGeneration) throw new Error('Canva generation preview is disabled on this deployment.');
  const text = clean(brief, 5000);
  if (!text) throw new Error('Design brief is required.');
  if (!['doc', 'presentation'].includes(type)) throw new Error('AI design generation supports doc or presentation only.');
  return canvaApi(uid, 'generations', {
    method: 'POST', body: { brief: text, design_type: { type: 'preset', name: type } }
  });
}
export async function getGeneration(uid, jobId) {
  if (!config().previewGeneration) throw new Error('Canva generation preview is disabled on this deployment.');
  const result = await canvaApi(uid, `generations/${safeId(jobId, 'generation job ID')}`);
  return { job: result.job || {} };
}

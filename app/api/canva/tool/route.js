import { NextResponse } from 'next/server';
import { verifyToolToken, readAccount } from '@/lib/canva';
import {
  listDesigns, getDesign, createDesign, startExport, getExport,
  listFolder, createFolder, listBrandTemplates, getBrandTemplate, getAsset,
  getCapabilities, generateDesign, getGeneration, renameFolder, deleteFolder,
  uploadAssetFromUrl, getAssetUpload, updateAsset, deleteAsset, commentOnDesign
} from '@/lib/canva-operations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function errorResult(message, id) {
  return NextResponse.json({ results: [{ toolCallId: id, result: message }], result: message });
}
export async function POST(request) {
  const uid = verifyToolToken(new URL(request.url).searchParams.get('token') || '');
  if (!uid) return NextResponse.json({ error: 'Unauthorized Canva agent tool call.' }, { status: 401 });
  let id;
  try {
    if (!(await readAccount(uid))) throw new Error('Connect Canva first.');
    const body = await request.json();
    const call = body?.message?.toolCalls?.[0] || body?.toolCall || body;
    id = call?.id;
    const name = call?.function?.name || call?.name || body?.name;
    const raw = call?.function?.arguments || call?.arguments || body?.arguments || {};
    const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool parameters.');
    // Explicit approval for all modifications, exports that generate downloadable files,
    // or credit-consuming AI generations. Do not execute unrecognized tools.
    const writes = new Set(['canva_create_design', 'canva_export_design', 'canva_create_folder', 'canva_generate_design', 'canva_rename_folder',
      'canva_delete_folder', 'canva_upload_asset_url', 'canva_update_asset', 'canva_delete_asset', 'canva_comment_design']);
    if (writes.has(name) && args.confirm !== true) throw new Error('Ask the account owner to confirm before using this Canva action.');
    let data;
    switch (name) {
      case 'canva_list_designs': data = await listDesigns(uid, args); break;
      case 'canva_get_design': data = await getDesign(uid, args.designId); break;
      case 'canva_create_design': data = await createDesign(uid, args); break;
      case 'canva_export_design': data = await startExport(uid, args); break;
      case 'canva_export_status': data = await getExport(uid, args.jobId); break;
      case 'canva_list_folder': data = await listFolder(uid, args); break;
      case 'canva_create_folder': data = await createFolder(uid, args); break;
      case 'canva_list_brand_templates': data = await listBrandTemplates(uid, args.query); break;
      case 'canva_get_brand_template': data = await getBrandTemplate(uid, args.templateId); break;
      case 'canva_get_asset': data = await getAsset(uid, args.assetId); break;
      case 'canva_upload_asset_url': data = await uploadAssetFromUrl(uid, args); break;
      case 'canva_upload_asset_status': data = await getAssetUpload(uid, args.jobId); break;
      case 'canva_update_asset': data = await updateAsset(uid, args); break;
      case 'canva_delete_asset': data = await deleteAsset(uid, args.assetId); break;
      case 'canva_rename_folder': data = await renameFolder(uid, args); break;
      case 'canva_delete_folder': data = await deleteFolder(uid, args.folderId); break;
      case 'canva_comment_design': data = await commentOnDesign(uid, args); break;
      case 'canva_get_capabilities': data = await getCapabilities(uid); break;
      case 'canva_generate_design': data = await generateDesign(uid, args); break;
      case 'canva_generation_status': data = await getGeneration(uid, args.jobId); break;
      default: throw new Error('Unknown Canva tool.');
    }
    const result = JSON.stringify(data).slice(0, 15000);
    return NextResponse.json({ results: [{ toolCallId: id, result }], result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResult(`Canva tool failed: ${error?.message || 'Unknown error.'}`, id); }
}

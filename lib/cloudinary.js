// lib/cloudinary.js
// Cloudinary is configured ONCE here and imported everywhere else.
// Backend uses the API secret (server-side operations only):
//   - DELETE images when an ad is deleted
//   - MODERATE / transform images if needed in future
//
// Frontend uses an UNSIGNED upload preset (no secret exposed):
//   - Browser uploads directly to Cloudinary
//   - No file ever passes through your Express server
//   - Faster uploads, no multer needed

import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true, // always use https URLs
});

export default cloudinary;

/**
 * Delete one image by its publicId.
 * Called from adController.deleteAd and updateAd (when images are replaced).
 */
export async function deleteImage(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    // Non-fatal — log and continue. Ad is deleted regardless.
    console.warn(
      `Cloudinary: failed to delete image ${publicId}:`,
      err.message,
    );
  }
}

/**
 * Delete multiple images in parallel.
 * Uses allSettled so one failure doesn't block the others.
 */
export async function deleteImages(publicIds = []) {
  const ids = publicIds.filter(Boolean);
  if (!ids.length) return;
  await Promise.allSettled(ids.map(deleteImage));
}


import multer from "multer";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import cloudinary from "../config/cloudinary.js";


const uploadPath = "uploads/";

if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ["image/jpeg", "image/png", "image/jpg", "image/webp"];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only images allowed"));
    }
  },
});


export const processImages = async (req, res, next) => {
  console.log("FILES RECEIVED:", req.files);

  if (!req.files || req.files.length === 0) return next();

  try {
    const uploadedImages = [];

    for (const file of req.files) {
      const buffer = await sharp(file.buffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "smilebaba-products" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          },
        );

        stream.end(buffer);
      });

      uploadedImages.push(result.secure_url);
    }

    req.processedImages = uploadedImages;

    next();
  } catch (error) {
    next(error);
  }
};












// const storage = new CloudinaryStorage({
//   cloudinary: cloudinary,
//   params: {
//     folder: "smilebaba-products",
//     allowed_formats: ["jpg", "jpeg", "png", "webp"],
//   },
// });






// const storage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     cb(null, "uploads/");
//   },

//   filename: function (req, file, cb) {
//     const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9);

//     cb(null, uniqueName + path.extname(file.originalname));
//   },
// });














//   destination: (req, file, cb) => {
  //     cb(null, "uploads/");
  //   },
  //   filename: (req, file, cb) => {
    //     cb(null, Date.now() + "-" + file.originalname);
    //   },
    // });
    
    // const upload = multer({
      //   storage,
      //   limits: { fileSize: 10 * 1024 * 1024 },
      // });
      // const storage = multer.diskStorage({

import multer from "multer";
import sharp from "sharp";
import fs from "fs";
import path from "path";

const uploadPath = "uploads/";

if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

// multer storage (temporary memory storage)
const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, 
});

export const processImages = async (req, res, next) => {
  if (!req.files) return next();
  
  const processedImages = [];
  
  for (let file of req.files) {
    const filename = Date.now() + "-" + file.originalname;
    const filepath = path.join(uploadPath, filename);
    
    await sharp(file.buffer)
    .resize(1200)
    .jpeg({ quality: 80 }) 
    .toFile(filepath);
    
    processedImages.push(`/uploads/${filename}`);
  }
  
  req.processedImages = processedImages;
  
  next();
};






























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
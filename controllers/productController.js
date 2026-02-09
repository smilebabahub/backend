import Product from "../models/Product.js";

export const createProduct = async (req, res) => {
  try {
    const { name, description, price, stock } = req.body;

    if (!name || !price) {
      return res.status(400).json({
        message: "Name and price required",
      });
    }

    const images = req.files?.map((file, index) => ({
      url: `/uploads/${file.filename}`,
      isCover: index === 0,
    }));

    const product = await Product.create({
      name,
      description,
      price,
      stock,
      images,
      vendor: req.user.userId,
    });

    res.status(201).json({
      message: "Product added successfully",
      product,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

import Product from "../models/Product.js";

//Create add products here: only suscribed venodrs are eligible
export const createProduct = async (req, res) => {
  try {
    const { name, description, price, stock } = req.body;

    if (!name || !price) {
      return res.status(400).json({
        message: "Name and price are required",
      });
    }

    const images =
      req.files?.map((file, index) => ({
        url: `/uploads/${file.filename}`,
        isCover: index === 0,
      })) || [];

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

// fetching all products
export const getProducts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;

    const skip = (page - 1) * limit;

    const products = await Product.find({ isActive: true })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("vendor", "name phone");

    const total = await Product.countDocuments({ isActive: true });

    res.status(200).json({
      total,
      page,
      pages: Math.ceil(total / limit),
      products,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

//fetching a single product
export const getProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate(
      "vendor",
      "name phone",
    );

    if (!product || !product.isActive) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// updating endpoint here
export const updateProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product || !product.isActive) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    // checking the vendors' authorization
    if (product.vendor.toString() !== req.user.userId) {
      return res.status(403).json({
        message: "Not authorized to update this product",
      });
    }

    const { name, description, price, stock, isActive } = req.body;

    // Replace images if new ones uploaded
    let images = product.images;

    if (req.files?.length > 0) {
      images = req.files.map((file, index) => ({
        url: `/uploads/${file.filename}`,
        isCover: index === 0,
      }));
    }

    product.name = name ?? product.name;
    product.description = description ?? product.description;
    product.price = price ?? product.price;
    product.stock = stock ?? product.stock;
    product.images = images;
    product.isActive = isActive ?? product.isActive;

    await product.save();

    res.status(200).json({
      message: "Product updated successfully",
      product,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// delete endpoint
export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product || !product.isActive) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    if (product.vendor.toString() !== req.user.userId) {
      return res.status(403).json({
        message: "Not authorized",
      });
    }

    product.isActive = false;

    await product.save();

    res.status(200).json({
      message: "Product deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

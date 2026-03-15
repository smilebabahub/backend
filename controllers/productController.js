import Product from "../models/Product.js";

//Create add products here: only suscribed venodrs are eligible
export const createProduct = async (req, res) => {
  try {
    const {
      title,
      category,
      subcategory,
      type,
      name,
      description,
      price,
      stock,
      region,
      city,
      phone,
    } = req.body;

    if (
      !title ||
      !category ||
      !subcategory ||
      !type ||
      !description ||
      !region ||
      !city ||
      !price ||
      !name ||
      !phone
    ) {
      return res.status(400).json({
        message: "All required fields must be filled",
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        message: "Please upload at least one image",
      });
    }

    const images = req.files.map((file, index) => ({
      url: `/uploads/${file.filename}`,
      isCover: index === 0,
    }));

    const product = await Product.create({
      title,
      category,
      subcategory,
      type,
      region,
      city,
      phone,
      name,
      description,
      price,
      stock,
      images,
      vendor: req.user.userId,
    });

    res.status(201).json({
      message: "Product created successfully",
      product,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Server error",
    });
  }
};



export const getAllProducts = async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const keyword = req.query.search
      ? {
          name: { $regex: req.query.search, $options: "i" },
        }
      : {};

    const products = await Product.find({ ...keyword })
      .populate("vendor", "username email role") // safe fields only
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Product.countDocuments({ ...keyword });

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



export const getSingleProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate(
      "vendor",
      "username email role",
    );

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};



export const updateProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    const isOwner = product.vendor.toString() === req.user.userId;
    const isAdmin = req.user.role === "admin";
    const isSubscribedVendor =
      req.user.role === "vendor" && req.user.isSubscribed;

    if (!(isAdmin || (isOwner && isSubscribedVendor))) {
      return res.status(403).json({
        message: "Not authorized to update this product",
      });
    }

    const { name, description, price, stock } = req.body;

    if (name) product.name = name;
    if (description) product.description = description;
    if (price) product.price = price;
    if (stock) product.stock = stock;

    if (req.files && req.files.length > 0) {
      product.images = req.files.map((file, index) => ({
        url: `/uploads/${file.filename}`,
        isCover: index === 0,
      }));
    }

    await product.save();

    res.json({
      message: "Product updated successfully",
      product,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    const isOwner = product.vendor.toString() === req.user.userId;
    const isAdmin = req.user.role === "admin";
    const isSubscribedVendor =
      req.user.role === "vendor" && req.user.isSubscribed;

    if (!(isAdmin || (isOwner && isSubscribedVendor))) {
      return res.status(403).json({
        message: "Not authorized to delete this product",
      });
    }

    await product.deleteOne();

    res.json({
      message: "Product deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

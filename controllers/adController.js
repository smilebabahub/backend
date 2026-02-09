import Ad from "../models/Ad.js";

export const createAd = async (req, res) => {
  try {
    const {
      title,
      categoryMain,
      categorySub,
      categoryType,
      region,
      city,
      description,
      negotiable,
      price,
      contactName,
      contactPhone,
      deliveryOption,
      plan,
      packageType,
    } = req.body;

    if (!title || !price || !contactPhone) {
      return res.status(400).json({
        message: "Required fields missing",
      });
    }

    const images = req.files?.map((file, index) => ({
      url: `/uploads/${file.filename}`,
      isCover: index === 0,
    }));

    const expiresAt =
      plan === "daily"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000)
        : plan === "weekly"
          ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const ad = await Ad.create({
      title,
      category: {
        main: categoryMain,
        sub: categorySub,
        type: categoryType,
      },
      images,
      location: { region, city },
      description,
      negotiable,
      price,
      contact: {
        name: contactName,
        phone: contactPhone,
      },
      deliveryOption,
      subscription: {
        plan,
        package: packageType,
        expiresAt,
      },
      postedBy: req.user?.userId || null, // guest-safe
    });

    res.status(201).json({
      message: "Ad posted successfully",
      ad,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

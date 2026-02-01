import Ad from "../models/adModel"   ;

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

    if (!title || !categoryMain || !categorySub || !region || !city) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const images = req.files?.map((file, index) => ({
      url: `/uploads/${file.filename}`,
      isCover: index === 0,
    }));

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
      },
      user: req.user.userId,
    });

    res.status(201).json({
      message: "Ad posted successfully",
      ad,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};



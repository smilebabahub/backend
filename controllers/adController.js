import Ad from "../models/adModel.js";

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
      postedBy: req.user.userId,
    });

    res.status(201).json({
      message: "Ad posted successfully",
      ad,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// fetching a single add endpoint here
export const getSingleAd = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id).populate(
      "postedBy",
      "name phone",
    );

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    res.status(200).json(ad);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

//fetching all adds endpoint here
export const getAds = async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const ads = await Ad.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("postedBy", "name phone");

    res.status(200).json(ads);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// update endpoint here.
export const updateAd = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    // checking the authorized user here
    if (ad.postedBy.toString() !== req.user.userId) {
      return res.status(403).json({
        message: "You are not authorized to update this ad",
      });
    }

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

    // the image file updating here
    let images = ad.images;

    if (req.files && req.files.length > 0) {
      images = req.files.map((file, index) => ({
        url: `/uploads/${file.filename}`,
        isCover: index === 0,
      }));
    }

    //  handling the expiration recalculation here
    let expiresAt = ad.subscription?.expiresAt;

    if (plan) {
      expiresAt =
        plan === "daily"
          ? new Date(Date.now() + 24 * 60 * 60 * 1000)
          : plan === "weekly"
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    }

    const updatedFields = {
      title: title ?? ad.title,

      category: {
        main: categoryMain ?? ad.category.main,
        sub: categorySub ?? ad.category.sub,
        type: categoryType ?? ad.category.type,
      },

      location: {
        region: region ?? ad.location.region,
        city: city ?? ad.location.city,
      },

      description: description ?? ad.description,
      negotiable: negotiable ?? ad.negotiable,
      price: price ?? ad.price,

      contact: {
        name: contactName ?? ad.contact.name,
        phone: contactPhone ?? ad.contact.phone,
      },

      deliveryOption: deliveryOption ?? ad.deliveryOption,

      images,

      subscription: {
        plan: plan ?? ad.subscription?.plan,
        package: packageType ?? ad.subscription?.package,
        expiresAt,
      },
    };

    const updatedAd = await Ad.findByIdAndUpdate(req.params.id, updatedFields, {
      new: true,
      runValidators: true,
    });

    res.status(200).json({
      message: "Ad updated successfully",
      ad: updatedAd,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// deleting endpoint here
export const deleteAd = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    if (ad.postedBy?.toString() !== req.user.userId) {
      return res.status(403).json({
        message: "You are not authorized to delete this ad",
      });
    }

    await ad.deleteOne();

    res.status(200).json({
      message: "Ad deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

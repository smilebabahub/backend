const subscribedOnly = (req, res, next) => {
  if (!req.user.isSubscribed) {
    return res.status(403).json({
      message: "Active subscription required",
    });
  }

  next();
};

export default subscribedOnly;

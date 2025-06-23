module.exports = async () => {
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  // Wait a bit to allow connections to close
  await new Promise(resolve => setTimeout(resolve, 100));
};

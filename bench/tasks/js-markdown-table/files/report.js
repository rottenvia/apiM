import { renderTable } from "./table.js";

const products = [
  { sku: "W-1", name: "Widget", stock: 12, price: 2.5, tags: "tools|metal" },
  { sku: "W-22", name: "ウィジェット", stock: 3, price: 12, tags: "jp" },
  { sku: "G-7", name: "Gadget 🚀", stock: 140, price: null, tags: "new\nhot" },
];

console.log(renderTable(products, { align: { sku: "center" } }));

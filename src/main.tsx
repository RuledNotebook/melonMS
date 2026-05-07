/* @refresh reload */
import { render } from "solid-js/web";
import { App } from "./App";
import "./index.css";
import "uplot/dist/uPlot.min.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

render(() => <App />, root);

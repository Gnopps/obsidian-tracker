import { App, Plugin } from "obsidian";
import { MarkdownPostProcessorContext, MarkdownView, Editor } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import { render, renderErrorMessage } from "./rendering";
import { getRenderInfoFromYaml } from "./parsing";
import { NullableNumber, Datasets, Query, QueryValuePair } from "./data";
import {
    TrackerSettings,
    DEFAULT_SETTINGS,
    TrackerSettingTab,
} from "./settings";
import { Moment } from "moment";
/* test-code-start */
import { Timer } from "./data";
/* test-code-end */

declare global {
    interface Window {
        app: App;
        moment: () => Moment;
    }
}

enum OutputType {
    Line,
    Bar,
    Radar,
    Summary,
    Table,
    Heatmap,
}

export default class Tracker extends Plugin {
    settings: TrackerSettings;

    async onload() {
        console.log("loading obsidian-tracker plugin");

        await this.loadSettings();

        this.addSettingTab(new TrackerSettingTab(this.app, this));

        this.registerMarkdownCodeBlockProcessor(
            "tracker",
            this.postprocessor.bind(this)
        );

        this.addCommand({
            id: "add-line-chart-tracker",
            name: "Add Line Chart Tracker",
            callback: () => this.addCodeBlock(OutputType.Line),
        });

        this.addCommand({
            id: "add-summary-tracker",
            name: "Add Summary Tracker",
            callback: () => this.addCodeBlock(OutputType.Summary),
        });
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    onunload() {
        console.log("unloading obsidian-tracker plugin");
    }

    getFilesInFolder(
        folder: TFolder,
        includeSubFolders: boolean = true
    ): TFile[] {
        let files: TFile[] = [];

        for (let item of folder.children) {
            if (item instanceof TFile) {
                if (item.extension === "md") {
                    files.push(item);
                }
            } else {
                if (item instanceof TFolder && includeSubFolders) {
                    files = files.concat(this.getFilesInFolder(item));
                }
            }
        }

        return files;
    }

    getFiles(folderToSearch: string, includeSubFolders: boolean = true) {
        let files: TFile[] = [];

        let folder = this.app.vault.getAbstractFileByPath(
            normalizePath(folderToSearch)
        );
        if (!folder || !(folder instanceof TFolder)) {
            // Folder not exists
        } else {
            files = files.concat(this.getFilesInFolder(folder));
        }

        return files;
    }

    addToDataMap(
        dataMap: Map<string, Array<QueryValuePair>>,
        date: string,
        query: Query,
        value: NullableNumber
    ) {
        if (!dataMap.has(date)) {
            let queryValuePairs = new Array<QueryValuePair>();
            queryValuePairs.push({ query: query, value: value });
            dataMap.set(date, queryValuePairs);
        } else {
            let targetValuePairs = dataMap.get(date);
            targetValuePairs.push({ query: query, value: value });
        }
    }

    async postprocessor(
        source: string,
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext
    ) {
        const canvas = document.createElement("div");

        /* test-code-start */
        let timer = new Timer("Main");
        timer.start("getRenderInfoFromYAML");
        /* test-code-end */

        let yamlText = source.trim();
        let renderInfo = getRenderInfoFromYaml(yamlText, this);
        if (typeof renderInfo === "string") {
            let errorMessage = renderInfo;
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }
        // console.log(renderInfo);

        /* test-code-start */
        timer.endAndPrint();
        timer.start("collectingData");
        /* test-code-end */

        // Get files
        let files: TFile[];
        try {
            files = this.getFiles(renderInfo.folder);
        } catch (e) {
            let errorMessage = e.message;
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }
        // console.log(files);

        // let dailyNotesSettings = getDailyNoteSettings();
        // console.log(dailyNotesSettings);
        // I always got YYYY-MM-DD from dailyNotesSettings.format
        // Use own settings panel for now

        // Collecting data to dataMap first
        let minDate = window.moment("");
        let maxDate = window.moment("");
        let fileCounter = 0;

        // console.log(renderInfo.queries);
        let dataMap = new Map<string, Array<QueryValuePair>>(); // {strDate: [query: value, ...]}
        for (let file of files) {
            // console.log(file.name);
            for (let query of renderInfo.queries) {
                let fileBaseName = file.basename;

                if (
                    renderInfo.dateFormatPrefix &&
                    fileBaseName.startsWith(renderInfo.dateFormatPrefix)
                ) {
                    fileBaseName = fileBaseName.slice(
                        renderInfo.dateFormatPrefix.length
                    );
                }
                if (
                    renderInfo.dateFormatSuffix &&
                    fileBaseName.endsWith(renderInfo.dateFormatSuffix)
                ) {
                    fileBaseName = fileBaseName.slice(
                        0,
                        fileBaseName.length - renderInfo.dateFormatSuffix.length
                    );
                }
                // console.log(fileBaseName);

                let fileDate = window.moment(
                    fileBaseName,
                    renderInfo.dateFormat,
                    true
                );
                // console.log(fileDate);
                // TODO: should exclude files out of date range
                if (!fileDate.isValid()) {
                    // console.log("file " + fileBaseName + " rejected");
                    continue;
                } else {
                    // console.log("file " + fileBaseName + " accepted");
                    if (renderInfo.startDate !== null) {
                        if (fileDate < renderInfo.startDate) {
                            continue;
                        }
                    }
                    if (renderInfo.endDate !== null) {
                        if (fileDate > renderInfo.endDate) {
                            continue;
                        }
                    }
                    fileCounter++;
                }
                // console.log(query);
                // console.log(fileBaseName);

                // Get min/max date
                if (fileCounter == 1) {
                    minDate = fileDate.clone();
                    maxDate = fileDate.clone();
                } else {
                    if (fileDate < minDate) {
                        minDate = fileDate.clone();
                    }
                    if (fileDate > maxDate) {
                        maxDate = fileDate.clone();
                    }
                }

                // rules for assigning tag value
                // simple tag
                //   tag exists --> constant value
                //   tag not exists --> null
                // valued-attached tag
                //   tag exists
                //     with value --> that value
                //     without value --> null
                //   tag not exists --> null

                let fileCache = this.app.metadataCache.getFileCache(file);

                // console.log("Search frontmatter tags");
                if (query.getType() === "tag") {
                    // Add frontmatter tags, allow simple tag only
                    if (fileCache) {
                        let frontMatter = fileCache.frontmatter;
                        let frontMatterTags: string[] = [];
                        if (frontMatter && frontMatter.tags) {
                            // console.log(frontMatter.tags);
                            let tagMeasure = 0.0;
                            let tagExist = false;
                            if (Array.isArray(frontMatter.tags)) {
                                frontMatterTags = frontMatterTags.concat(
                                    frontMatter.tags
                                );
                            } else {
                                frontMatterTags.push(frontMatter.tags);
                            }

                            for (let tag of frontMatterTags) {
                                if (tag === query.getTarget()) {
                                    // simple tag
                                    tagMeasure =
                                        tagMeasure +
                                        renderInfo.constValue[query.getId()];
                                    tagExist = true;
                                } else if (
                                    tag.startsWith(query.getTarget() + "/")
                                ) {
                                    // nested tag
                                    tagMeasure =
                                        tagMeasure +
                                        renderInfo.constValue[query.getId()];
                                    tagExist = true;
                                } else {
                                    continue;
                                }

                                // valued-tag in frontmatter is not supported
                                // because the "tag:value" in frontmatter will be consider as a new tag for different values

                                let value = null;
                                if (tagExist) {
                                    value = tagMeasure;
                                }
                                this.addToDataMap(
                                    dataMap,
                                    fileDate.format(renderInfo.dateFormat),
                                    query,
                                    value
                                );
                            }
                        }
                    }
                } // Search frontmatter tags

                // console.log("Search frontmatter keys");
                if (
                    query.getType() === "frontmatter" &&
                    query.getTarget() !== "tags"
                ) {
                    if (fileCache) {
                        let frontMatter = fileCache.frontmatter;
                        if (frontMatter) {
                            if (frontMatter[query.getTarget()]) {
                                // console.log("single value");
                                // console.log(frontMatter[query.target]);
                                let value = frontMatter[query.getTarget()];
                                value = parseFloat(value);
                                if (Number.isNumber(value)) {
                                    this.addToDataMap(
                                        dataMap,
                                        fileDate.format(renderInfo.dateFormat),
                                        query,
                                        value
                                    );
                                }
                            } else if (
                                query.getParentTarget() &&
                                frontMatter[query.getParentTarget()]
                            ) {
                                // console.log("multiple values");
                                // console.log(frontMatter[query.parentTarget]);
                                let values =
                                    frontMatter[query.getParentTarget()];
                                if (typeof values === "string") {
                                    let splitted = values.split("/");
                                    if (
                                        splitted.length > query.getSubId() &&
                                        query.getSubId() >= 0
                                    ) {
                                        // TODO: it's not efficent to retrieve one value at a time, enhance this
                                        let value = parseFloat(
                                            splitted[query.getSubId()].trim()
                                        );
                                        if (Number.isNumber(value)) {
                                            this.addToDataMap(
                                                dataMap,
                                                fileDate.format(
                                                    renderInfo.dateFormat
                                                ),
                                                query,
                                                value
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                } // console.log("Search frontmatter keys");

                // console.log("Search wiki links");
                if (query.getType() === "wiki") {
                    if (fileCache) {
                        let links = fileCache.links;

                        let linkMeasure = 0.0;
                        let linkExist = false;
                        for (let link of links) {
                            if (link.link === query.getTarget()) {
                                linkExist = true;
                                linkMeasure =
                                    linkMeasure +
                                    renderInfo.constValue[query.getId()];
                            }
                        }

                        let linkValue = null;
                        if (linkExist) {
                            linkValue = linkMeasure;
                        }
                        this.addToDataMap(
                            dataMap,
                            fileDate.format(renderInfo.dateFormat),
                            query,
                            linkValue
                        );
                    }
                }

                // console.log("Search inline tags");
                if (query.getType() === "tag") {
                    // Add inline tags
                    let content = await this.app.vault.adapter.read(file.path);

                    // console.log(content);
                    // Test this in Regex101
                    // (^|\s)#tagName(\/[\w-]+)*(:(?<values>[\d\.\/-]*)[a-zA-Z]*)?([\\.!,\\?;~-]*)?(\s|$)
                    let tagName = query.getTarget();
                    if (query.getParentTarget()) {
                        tagName = query.getParentTarget(); // use parent tag name for multiple values
                    }
                    let strHashtagRegex =
                        "(^|\\s)#" +
                        tagName +
                        "(\\/[\\w-]+)*(:(?<values>[\\d\\.\\/-]*)[a-zA-Z]*)?([\\.!,\\?;~-]*)?(\\s|$)";
                    // console.log(strHashtagRegex);
                    let hashTagRegex = new RegExp(strHashtagRegex, "gm");
                    let match;
                    let tagMeasure = 0.0;
                    let tagExist = false;
                    while ((match = hashTagRegex.exec(content))) {
                        // console.log(match);
                        if (
                            !renderInfo.ignoreAttachedValue[query.getId()] &&
                            typeof match.groups !== "undefined" &&
                            typeof match.groups.values !== "undefined"
                        ) {
                            // console.log("value-attached tag");
                            let splitted = match.groups.values.split("/");
                            if (splitted.length === 1) {
                                // console.log("single-value");
                                let value = parseFloat(
                                    match.groups.values.trim()
                                );
                                // console.log(value);
                                if (!Number.isNaN(value)) {
                                    if (
                                        !renderInfo.ignoreZeroValue[
                                            query.getId()
                                        ] ||
                                        value !== 0
                                    ) {
                                        tagMeasure += value;
                                        tagExist = true;
                                    }
                                }
                            } else if (
                                splitted.length > query.getSubId() &&
                                query.getSubId() >= 0
                            ) {
                                // TODO: it's not efficent to retrieve one value at a time, enhance this
                                // console.log("multiple-values");
                                let value = parseFloat(
                                    splitted[query.getSubId()].trim()
                                );
                                if (Number.isNumber(value)) {
                                    tagMeasure += value;
                                    tagExist = true;
                                }
                            }
                        } else {
                            // console.log("simple-tag");
                            tagMeasure =
                                tagMeasure +
                                renderInfo.constValue[query.getId()];
                            tagExist = true;
                        }
                    }

                    let value = null;
                    if (tagExist) {
                        value = tagMeasure;
                    }
                    this.addToDataMap(
                        dataMap,
                        fileDate.format(renderInfo.dateFormat),
                        query,
                        value
                    );
                } // Search inline tags

                /* test-code-start */
                let timerTextSearch = new Timer("timerTextSearch");
                /* test-code-start */

                if (query.getType() === "text") {
                    /* test-code-start */
                    timerTextSearch.start("readingFile");
                    /* test-code-end */
                    let content = await this.app.vault.adapter.read(file.path);
                    /* test-code-start */
                    timerTextSearch.endAndPrint();
                    /* test-code-end */
                    // console.log(content);
                    let strTextRegex = query.getTarget();

                    let textRegex = new RegExp(strTextRegex, "gm");
                    let match;
                    let textMeasure = 0.0;
                    let textExist = false;

                    let matchCount = 0;
                    while ((match = textRegex.exec(content))) {
                        if (matchCount > 10000) {
                            break;
                        }
                        matchCount++;
                        if (
                            !renderInfo.ignoreAttachedValue[query.getId()] &&
                            typeof match.groups !== "undefined"
                        ) {
                            // match[0] whole match
                            // console.log("valued-text");
                            /* test-code-start */
                            timerTextSearch.start("regexMatching");
                            /* test-code-start */
                            if (typeof match.groups.value !== "undefined") {
                                // set as null for missing value if it is valued-tag
                                let value = parseFloat(match.groups.value);
                                // console.log(value);
                                if (!Number.isNaN(value)) {
                                    if (
                                        !renderInfo.ignoreZeroValue[
                                            query.getId()
                                        ] ||
                                        value !== 0
                                    ) {
                                        textMeasure += value;
                                        textExist = true;
                                    }
                                }
                            }
                            /* test-code-start */
                            timerTextSearch.endAndPrint();
                            /* test-code-end */
                        } else {
                            // console.log("simple-text");
                            textMeasure =
                                textMeasure +
                                renderInfo.constValue[query.getId()];
                            textExist = true;
                        }
                    }

                    if (textExist) {
                        this.addToDataMap(
                            dataMap,
                            fileDate.format(renderInfo.dateFormat),
                            query,
                            textMeasure
                        );
                    }
                } // Search text
            } // end loof of files
        }
        // console.log(minDate);
        // console.log(maxDate);
        // console.log(dataMap);

        // Check date range
        if (!minDate.isValid() || !maxDate.isValid()) {
            let errorMessage = "Invalid date range";
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }
        if (renderInfo.startDate === null && renderInfo.endDate === null) {
            // No date arguments
            renderInfo.startDate = minDate.clone();
            renderInfo.endDate = maxDate.clone();
        } else if (
            renderInfo.startDate !== null &&
            renderInfo.endDate === null
        ) {
            if (renderInfo.startDate < maxDate) {
                renderInfo.endDate = maxDate.clone();
            } else {
                let errorMessage = "Invalid date range";
                renderErrorMessage(canvas, errorMessage);
                el.appendChild(canvas);
                return;
            }
        } else if (
            renderInfo.endDate !== null &&
            renderInfo.startDate === null
        ) {
            if (renderInfo.endDate > minDate) {
                renderInfo.startDate = minDate.clone();
            } else {
                let errorMessage = "Invalid date range";
                renderErrorMessage(canvas, errorMessage);
                el.appendChild(canvas);
                return;
            }
        } else {
            // startDate and endDate are valid
            if (
                (renderInfo.startDate < minDate &&
                    renderInfo.endDate < minDate) ||
                (renderInfo.startDate > maxDate && renderInfo.endDate > maxDate)
            ) {
                let errorMessage = "Invalid date range";
                renderErrorMessage(canvas, errorMessage);
                el.appendChild(canvas);
                return;
            }
        }
        // console.log(renderInfo.startDate);
        // console.log(renderInfo.endDate);

        /* test-code-start */
        timer.endAndPrint();
        timer.start("reshapeData");
        /* test-code-end */

        // Reshape data for rendering
        let datasets = new Datasets(renderInfo.startDate, renderInfo.endDate);
        for (let query of renderInfo.queries) {
            let dataset = datasets.createDataset(query, renderInfo);
            for (
                let curDate = renderInfo.startDate.clone();
                curDate <= renderInfo.endDate;
                curDate.add(1, "days")
            ) {
                // console.log(curDate);

                // dataMap --> {date: [query: value, ...]}
                if (dataMap.has(curDate.format(renderInfo.dateFormat))) {
                    let queryValuePairs = dataMap
                        .get(curDate.format(renderInfo.dateFormat))
                        .filter(function (pair) {
                            return pair.query.equalTo(query);
                        });
                    if (queryValuePairs.length > 0) {
                        // Merge values of the same day same query
                        let pair = queryValuePairs[0];
                        let value = 0;
                        let hasValue = false;
                        for (
                            let indPair = 0;
                            indPair < queryValuePairs.length;
                            indPair++
                        ) {
                            if (queryValuePairs[indPair].value !== null) {
                                value += queryValuePairs[indPair].value;
                                hasValue = true;
                            }
                        }
                        // console.log(hasValue);
                        // console.log(value);
                        if (hasValue) {
                            dataset.setValue(curDate, value);
                        }
                    }
                }
            }
        }
        renderInfo.datasets = datasets;
        // console.log(renderInfo.datasets);

        /* test-code-start */
        timer.endAndPrint();
        timer.start("rendering");
        /* test-code-end */

        let result = render(canvas, renderInfo);
        if (typeof result === "string") {
            let errorMessage = result;
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }

        el.appendChild(canvas);

        /* test-code-start */
        timer.endAndPrint();
        /* test-code-end */
    }

    getEditor(): Editor {
        return this.app.workspace.getActiveViewOfType(MarkdownView).editor;
    }

    addCodeBlock(outputType: OutputType): void {
        const currentView = this.app.workspace.activeLeaf.view;

        if (!(currentView instanceof MarkdownView)) {
            return;
        }

        let codeblockToInsert = "";
        switch (outputType) {
            case OutputType.Line:
                codeblockToInsert = `\`\`\` tracker
searchType: tag
searchTarget: tagName
folder: /
startDate:
endDate:
line:
    title: "Line Chart"
    xAxisLabel: Date
    yAxisLabel: Value
\`\`\``;
                break;
            case OutputType.Summary:
                codeblockToInsert = `\`\`\` tracker
searchType: tag
searchTarget: tagName
folder: /
startDate:
endDate:
summary:
    template: "Average value of tagName is {{average}}"
    style: "color:white;"
\`\`\``;
                break;
            default:
                break;
        }

        if (codeblockToInsert !== "") {
            let textInserted = this.insertToNextLine(codeblockToInsert);
            if (!textInserted) {
            }
        }
    }

    insertToNextLine(text: string): boolean {
        let editor = this.getEditor();

        if (editor) {
            let cursor = editor.getCursor();
            let lineNumber = cursor.line;
            let line = editor.getLine(lineNumber);

            cursor.ch = line.length;
            editor.setSelection(cursor);
            editor.replaceSelection("\n" + text);

            return true;
        }

        return false;
    }
}

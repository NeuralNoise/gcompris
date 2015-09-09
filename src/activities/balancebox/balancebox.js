/* GCompris - balancebox.js
 *
 * Copyright (C) 2014,2015 Holger Kaelberer <holger.k@elberer.de>
 *
 * Authors:
 *   Holger Kaelberer <holger.k@elberer.de>
 *
 *   This program is free software; you can redistribute it and/or modify
 *   it under the terms of the GNU General Public License as published by
 *   the Free Software Foundation; either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   This program is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU General Public License for more details.
 *
 *   You should have received a copy of the GNU General Public License
 *   along with this program; if not, see <http://www.gnu.org/licenses/>.
 */

/* ToDo:
  - levels, levels, levels
  (- fix inconsistent tilting behaviour on different android devices)
  - make sensitivity configurable?
  - use Qt classes instead of jni for orientation?
*/
.pragma library
.import QtQuick 2.0 as Quick
.import GCompris 1.0 as GCompris
.import Box2D 2.0 as Box2D

/**
 * Level description format:
 *
 * Example:
 * [ { "level": 1,
 *     "map": [ [ 0x0000,  0x0308, ... ],
 *              [ 0x0010,  0x0008, ... ],
 *              ...
 *            ],
 *     "targets": [ 1, 2, 3, 5, 10, ... ]
 *   },
 *   { "level": 2, ... }
 *   ...
 * ]
 * 
 * "level": Number of the level.
 * "map":   Definition of the map inside the balancebox.
 *          The map is a 2-dimensional array of map cells. A cell is
 *          described by a bitmask of 16 bit with the lower 8bit defining walls,
 *          objects, etc. (cf. below) and the higher 8 bit defining the order of
 *          buttons present on the map. The values of the buttons are described
 *          in the "targets" property.
 * "targets": Values of the buttons present on the map. Most likely these will
 *            be numbers, but letters are also possible. The order in which they
 *            need to be pressed by the ball is defined in the higher 8 bits of
 *            the map fields.
 */
var EMPTY   = 0x0000;
var NORTH   = 0x0001;
var EAST    = 0x0002;
var SOUTH   = 0x0004;
var WEST    = 0x0008;
// all the following are mutually exclusive:
var START   = 0x0010;
var GOAL    = 0x0020;
var HOLE    = 0x0040;
var CONTACT = 0x0080;

var dataset = null;

// Parameters that control the ball's dynamics
var m = 0.2; // without ppm-correction: 10
var g = 9.81; // without ppm-correction: 50.8
var box2dPpm = 32;    // pixelsPerMeter used in Box2D's world
var boardSizeM = 0.9; // board's real edge length, fixed to 30 cm
var boardSizePix = 500;  // board's current size in pix (acquired dynamically)
var dpiBase=139;
var curDpi = null;
var pixelsPerMeter = null;
var vFactor = pixelsPerMeter / box2dPpm; // FIXME: calculate!

var step = 20;   // time step (in ms)
var friction = 0.15;
var restitution = 0.3;  // rebounce factor

// stuff for keyboard based tilting
var keyboardTiltStep = 0.25;   // degrees
var keyboardTimeStep = 20;    // ms
var lastKey;
var keyboardIsTilting = false;  // tilting or resetting to horizontal

var debugDraw = false;
var currentLevel = 0;
var numberOfLevel = 0;
var items;
var baseUrl = "qrc:/gcompris/src/activities/balancebox/resource";
var levelsFile = baseUrl + "/levels-default.json"; 
var level;
var map; // current map
var goal;
var goalUnlocked;
var holes;
var walls;
var contacts;
var lastContact;
var ballContacts;
var wallComponent = Qt.createComponent("qrc:/gcompris/src/activities/balancebox/Wall.qml");
var contactComponent = Qt.createComponent("qrc:/gcompris/src/activities/balancebox/BalanceContact.qml");
var balanceItemComponent = Qt.createComponent("qrc:/gcompris/src/activities/balancebox/BalanceItem.qml");
var contactIndex = -1;

function start(items_) {
    items = items_;

    if (GCompris.ApplicationInfo.isMobile) {
        var or = GCompris.ApplicationInfo.getRequestedOrientation();
        GCompris.ApplicationInfo.setRequestedOrientation(5);
        /* -1: SCREEN_ORIENTATION_UNSPECIFIED
         * 0:  SCREEN_ORIENTATION_LANDSCAPE: forces landscape, inverted rotation
         *     on S2
         * 5:  SCREEN_ORIENTATION_NOSENSOR:
         *     forces 'main' orientation mode on each device (portrait on handy
         *     landscape on tablet and reports rotation correctly)
         * 14: SCREEN_ORIENTATION_LOCKED: inverted rotation on tablet
         */
    }

    // set up dynamic variables for movement:
    pixelsPerMeter = boardSizePix / boardSizeM / (items.dpi / dpiBase);
    vFactor = pixelsPerMeter / box2dPpm;

    console.log("Starting: pixelsPerM=" + items.world.pixelsPerMeter
            + " timeStep=" + items.world.timeStep
            + " posIterations=" + items.world.positionIterations
            + " velIterations=" + items.world.velocityIterations
            + " boardSizePix=" + boardSizePix
            + " pixelsPerMeter=" + pixelsPerMeter
            + " vFactor=" + vFactor
            + " dpi=" + items.dpi);

    goal = null;
    holes = new Array();
    walls = new Array();
    contacts = new Array();
    ballContacts = new Array();
    currentLevel = 0;
    
    dataset = items.parser.parseFromUrl(levelsFile, validateLevels);
    if (dataset == null) {
        console.error("Balancebox: Error loading levels from " + levelsFile
                + ", can't continue!");
        return;
    }
    numberOfLevel = dataset.length;

    initLevel();
}

function validateLevels(doc)
{
    // minimal syntax check:
    if (undefined === doc || !Array.isArray(doc) || doc.length < 1)
        return false;
    for (var i = 0; i < doc.length; i++) {
        if (undefined === doc[i].map || !Array.isArray(doc[i].map) ||
                doc[i].map.length < 1)
            return false;
    }
    return true;
}

function sinDeg(num) {return Math.sin(num/180*Math.PI);};

function moveBall()
{
 //   console.log("tilt: " + items.tilt.xRotation + "/" + items.tilt.yRotation );
    var dt = step / 1000;
    var dvx = ((m*g*dt) * sinDeg(items.tilt.yRotation)) / m;
    var dvy = ((m*g*dt) * sinDeg(items.tilt.xRotation)) / m;

/*    console.log("moving ball: dv: " + items.ball.body.linearVelocity.x
            + "/" + items.ball.body.linearVelocity.y 
            +  " -> " + (items.ball.body.linearVelocity.x+dvx) 
            + "/" + (items.ball.body.linearVelocity.y+dvy));
  */
    
    items.ball.body.linearVelocity.x += dvx * vFactor;
    items.ball.body.linearVelocity.y += dvy * vFactor;
    
    checkBallContacts();

}

function checkBallContacts()
{
    for (var k = 0; k < ballContacts.length; k++) {
        //console.log("XXX checking ballContact of type " + ballContacts[k].categories);
        if (items.ball.x > ballContacts[k].x - items.ball.width/2 &&
            items.ball.x < ballContacts[k].x + items.ball.width/2 &&
            items.ball.y > ballContacts[k].y - items.ball.width/2 &&
            items.ball.y < ballContacts[k].y + items.ball.width/2) {
            // collision
            if (ballContacts[k].categories == items.holeType)
                finishBall(false, ballContacts[k].x, ballContacts[k].y);
            else if (ballContacts[k].categories == items.goalType && goalUnlocked)
                finishBall(true, ballContacts[k].x, ballContacts[k].y);
            else if (ballContacts[k].categories == items.buttonType) {
                /*console.log("XXX hit button " + k + " index="
                        + contacts.indexOf(ballContacts[k]) + " orderNum=" 
                        + ballContacts[k].orderNum + " lastContact=" + lastContact
                        + " length=" + contacts.length);*/
                if (!ballContacts[k].pressed
                    && ballContacts[k].orderNum == lastContact + 1)
                {
                    ballContacts[k].pressed = true;
                    lastContact = ballContacts[k].orderNum;
                    console.log("unlocked next contact " + lastContact
                            + " length=" + contacts.length);
                    if (lastContact == contacts.length) {
                        console.log("door unlocked");
                        goalUnlocked = true;
                        goal.imageSource = baseUrl + "/door.svg";
                    }
                }
            }
        }
    }
}

function finishBall(won, x, y)
{
    items.timer.stop();
    items.keyboardTimer.stop();
    items.ball.x = x;
    items.ball.y = y;
    items.ball.scale = 0.4;
    items.ball.body.linearVelocity = Qt.point(0, 0);
    if (won)
        items.bonus.good("flower");
    else
        items.bonus.bad("flower");
}

function stop() {
    // reset everything
    tearDown();
}

function createObject(component, properties)
{
    var p = properties;
    p.world = items.world;
    var object = component.createObject(items.mapWrapper, p);
    //console.log("XXX created object " + JSON.stringify(object) + " shadow:" + object.shadow);
    return object;
}

function initMap()
{
    var modelMap = new Array();
    goalUnlocked = true;
    items.mapWrapper.rows = map.length;
    items.mapWrapper.columns = map[0].length;
    console.log("creating map of size " + items.mapWrapper.rows + "/" + items.mapWrapper.columns);
    items.ball.width = items.ball.height = items.cellSize - 2*items.wallSize;    
    for (var row = 0; row < map.length; row++) {
        for (var col = 0; col < map[row].length; col++) {
            var x = col * items.cellSize;
            var y = row * items.cellSize;
            var orderNum = (map[row][col] & 0xFF00) >> 8;
            //console.log("XXX processing field " + col + "/" + row + " : number=" + orderNum);
            // debugging:
            /*try {
                var rect = Qt.createQmlObject(
                        "import QtQuick 2.0;Rectangle{"
                       +"width:" + items.cellSize +";"
                       +"height:" + items.cellSize+";"
                       +"x:" + x + ";"
                       +"y:" + y +";"
                       +"color: \"transparent\";"
                       +"border.color: \"blue\";"
                       +"border.width: 1;"
                       +"}", items.mapWrapper);
            } catch (e) {
                console.error("Error creating object: " + e);
            }*/
            if (map[row][col] & NORTH) {
                walls.push(createObject(wallComponent, {x: x-items.wallSize/2, 
                    y: y-items.wallSize/2, width: items.cellSize + items.wallSize,
                    height: items.wallSize,
                    shadow: true, shadowHorizontalOffset: items.tilt.yRotation,
                    shadowVerticalOffset: items.tilt.xRotation}));
            }
            if (map[row][col] & SOUTH) {
                walls.push(createObject(wallComponent, {x: x-items.wallSize/2,
                    y: y+items.cellSize-items.wallSize/2,
                    width: items.cellSize+items.wallSize, height: items.wallSize,
                    shadow: true, shadowHorizontalOffset: items.tilt.yRotation,
                    shadowVerticalOffset: items.tilt.xRotation}));
            }
            if (map[row][col] & EAST) {
                walls.push(createObject(wallComponent, {x: x+items.cellSize-items.wallSize/2,
                    y: y-items.wallSize/2, width: items.wallSize, 
                    height: items.cellSize+items.wallSize, shadow: true,
                    shadowHorizontalOffset: items.tilt.yRotation,
                    shadowVerticalOffset: items.tilt.xRotation}));
            }
            if (map[row][col] & WEST) {
                walls.push(createObject(wallComponent, {x: x-items.wallSize/2,
                    y: y-items.wallSize/2, width: items.wallSize,
                    height: items.cellSize+items.wallSize, shadow: true,
                    shadowHorizontalOffset: items.tilt.yRotation,
                    shadowVerticalOffset: items.tilt.xRotation}));
            }

            if (map[row][col] & START) {
                items.ball.x = col * items.cellSize + items.wallSize/2;
                items.ball.y = row * items.cellSize + items.wallSize/2;
                //console.log("setting ball to col/row " + col + "/" + row
                //        + "  " + items.ball.x + "/" + items.ball.y);
            }
            
            if (map[row][col] & GOAL) {
                var goalX = col * items.cellSize + items.wallSize/2;
                var goalY = row * items.cellSize + items.wallSize/2;
                goal = createObject(balanceItemComponent, {
                        x: goalX, y: goalY,
                        width: items.ball.width, height: items.ball.height,
                        imageSource: baseUrl + "/door_closed.svg",
                        categories: items.goalType,
                        sensor: true});
                //console.log("found goal at col/row " + col + "/" + row
                //        + "  " + goalX + "/" + goalY);
            }
            
            if (map[row][col] & HOLE) {
                var holeX = col * items.cellSize + items.wallSize/2;
                var holeY = row * items.cellSize + items.wallSize/2;
                /*holes.push(createObject(holeComponent, {x: holeX, y: holeY,
                        width: items.ball.width, height: items.ball.height}));*/
                holes.push(createObject(balanceItemComponent, {
                    x: holeX, y: holeY,
                    width: items.ball.width, height: items.ball.height,
                    imageSource: baseUrl + "/hole.svg",
                    density: 0, friction: 0, restitution: 0,
                    categories: items.holeType,
                    sensor: true}));
                //console.log("found hole at col/row " + col + "/" + row + "  " + holeX + "/" + holeY);
            }
            
            if (orderNum > 0) {
                var contactX = col * items.cellSize + items.wallSize/2;
                var contactY = row * items.cellSize + items.wallSize/2;
                goalUnlocked = false;
                contacts.push(createObject(contactComponent, {
                    x: contactX, y: contactY,
                    width: items.cellSize - items.wallSize, 
                    height: items.cellSize - items.wallSize,
                    //width: items.cellSize, height: items.cellSize,
                    pressed: false,
                    density: 0, friction: 0, restitution: 0,
                    categories: items.buttonType,
                    sensor: true,
                    orderNum: orderNum,
                    text: level.targets[orderNum-1]}));
                //console.log("found contact at col/row " + col + "/" + row
                //        + "  " + contactX + "/" + contactY + " w/h=" + (items.cellSize - items.wallSize));
            }
        }
        //modelMap = modelMap.concat(map[row]);
    }
//    console.log("setting model to " + JSON.stringify(modelMap)
//            + " cellsize=" + items.cellSize + " wallsize"+items.wallSize);
    //items.mazeRepeater.model = modelMap;
}

function addBallContact(item)
{
    if (ballContacts.indexOf(item) !== -1)
        return;
    //console.log("adding ball contact");
    ballContacts.push(item);
}

function removeBallContact(item)
{
    var index = ballContacts.indexOf(item);
    if (index > -1) {
        //console.log("removing ball contact");
        ballContacts.splice(index, 1);
    }
}

function tearDown()
{
    items.timer.stop();
    items.keyboardTimer.stop();
    if (holes.length > 0) {
        for (var i = 0; i< holes.length; i++)
            holes[i].destroy();
        holes.length = 0;
    }
    if (walls.length > 0) {
        for (var i = 0; i< walls.length; i++)
            walls[i].destroy();
        walls.length = 0;
    }
    if (contacts.length > 0) {
        for (var i = 0; i< contacts.length; i++)
            contacts[i].destroy();
        contacts.length = 0;
    }
    lastContact = 0;
    if (goal)
        goal.destroy();
    goal = null;
    items.tilt.xRotation = 0;
    items.tilt.yRotation = 0;
    items.ball.scale = 1;
    ballContacts = new Array();
}

function initLevel() {
    items.bar.level = currentLevel + 1;

    // reset everything
    tearDown();

    map = dataset[currentLevel].map;
    level = dataset[currentLevel];
    initMap();
    items.timer.start();
}

// keyboard tilting stuff:
function keyboardHandler()
{
    if (keyboardIsTilting) {
        if (lastKey == Qt.Key_Left)
            items.tilt.yRotation -= keyboardTiltStep;
        else if (lastKey == Qt.Key_Right)
            items.tilt.yRotation += keyboardTiltStep;
        else if (lastKey == Qt.Key_Up)
            items.tilt.xRotation -= keyboardTiltStep;
        else if (lastKey == Qt.Key_Down)
            items.tilt.xRotation += keyboardTiltStep;
        items.keyboardTimer.start();
    } else {// is resetting
        // yRotation:
        if (items.tilt.yRotation < 0)
            items.tilt.yRotation = Math.min(items.tilt.yRotation + keyboardTiltStep, 0);
        else if (items.tilt.yRotation > 0)
            items.tilt.yRotation = Math.max(items.tilt.yRotation - keyboardTiltStep, 0);
        // xRotation:
        if (items.tilt.xRotation < 0)
            items.tilt.xRotation = Math.min(items.tilt.xRotation + keyboardTiltStep, 0);
        else if (items.tilt.xRotation > 0)
            items.tilt.xRotation = Math.max(items.tilt.xRotation - keyboardTiltStep, 0);
        // resetting done?
        if (items.tilt.yRotation != 0 || items.tilt.xRotation != 0)
            items.keyboardTimer.start();
    }
}

function processKeyPress(key)
{
    if (key == Qt.Key_Left
        || key == Qt.Key_Right
        || key == Qt.Key_Up
        || key == Qt.Key_Down) {
        lastKey = key;
        keyboardIsTilting = true;
        items.keyboardTimer.stop();
        keyboardHandler();
    }
}

function processKeyRelease(key)
{
    if (key == Qt.Key_Left
            || key == Qt.Key_Right
            || key == Qt.Key_Up
            || key == Qt.Key_Down) {
            lastKey = key;
            keyboardIsTilting = false;
            items.keyboardTimer.stop();
            keyboardHandler();
        }
}

function nextLevel() {
    if(numberOfLevel <= ++currentLevel ) {
        currentLevel = 0
    }
    initLevel();
}

function previousLevel() {
    if(--currentLevel < 0) {
        currentLevel = numberOfLevel - 1
    }
    initLevel();
}

var TOOL_H_WALL = SOUTH
var TOOL_V_WALL = EAST
var TOOL_HOLE = HOLE
var TOOL_CONTACT = CONTACT
var TOOL_GOAL = GOAL
var TOOL_BALL = START

function initEditor(props)
{
    console.log("XXX init editor " + props + " map: " + map);
    props.mapModel.clear();

    for (var row = 0; row < map.length; row++) {
        for (var col = 0; col < map[row].length; col++) {
            var contactValue = "";
            var value = parseInt(map[row][col]);  // always enforce number
            var orderNum = (value & 0xFF00) >> 8;
            if (orderNum > 0 && level.targets[orderNum - 1] === undefined) {
                console.error("Invalid level: orderNum " + orderNum
                              + " without target value!");
            } else if (orderNum > 0) {
                if (orderNum > props.lastOrderNum)
                    props.lastOrderNum = orderNum;
                contactValue = Number(level.targets[orderNum-1]).toString();
                if (contactValue > parseInt(props.contactValue) + 1)
                    props.contactValue = Number(parseInt(contactValue) + 1).toString();
            }
            props.mapModel.append({
                "row": row,
                "col": col,
                "value": value,
                "orn": orderNum,
                "contactValue": orderNum > 0 ? contactValue : ""
            });
            if (value & GOAL) {
                if (props.lastGoalIndex > -1) {
                    console.error("Invalid level: multiple goal locations: row/col="
                                  + row + "/" + col);
                    return;
                }
                props.lastGoalIndex = row * map.length + col;
            }
            if (value & START) {
                if (props.lastBallIndex > -1) {
                    console.error("Invalid level: multiple start locations: row/col="
                                  + row + "/" + col);
                    return;
                }
                props.lastBallIndex = row * map.length + col;
            }
        }
    }
}

function dec2hex(i) {
   return (i+0x10000).toString(16).substr(-4).toUpperCase();
}

function modelToLevel(props)
{
    map = new Array();
    var targets = new Array();
    for (var i = 0; i < props.mapModel.count; i++) {
        var row = Math.floor(i / props.columns);
        var col = i % props.columns;
        if (col === 0) {
            map[row] = new Array();
        }

        var obj = props.mapModel.get(i);
        var value = obj.value;
        if (obj.orn > 0) {
            value |= (obj.orn << 8);
            targets[obj.orn-1] = obj.contactValue;
        }
        map[row][col] = "0x" + dec2hex(value);
    }
    var level = {
                    level: "0",
                    map: map,
                    targets: targets
                }
    console.log("XXX level: " + JSON.stringify(level) + " - " + map);
}

function modifyMap(props, row, col)
{
    //console.log("XXX modify map currentTool='" + props.currentTool + "'");
    var modelIndex = row * map.length + col;
    var obj = props.mapModel.get(modelIndex);
    var newValue = obj.value;

    // special treatment for mutually exclusive ones:
    if (props.currentTool === TOOL_HOLE
            || props.currentTool === TOOL_GOAL
            || props.currentTool === TOOL_CONTACT
            || props.currentTool === TOOL_BALL) {
        // helper:
        var MUTEX_MASK = (START | GOAL | HOLE | CONTACT) ^ props.currentTool;
        newValue &= ~MUTEX_MASK;
    }

    // special treatment for singletons:
    if (props.currentTool === TOOL_GOAL) {
        console.log("GGGoal " + (obj.value & TOOL_GOAL));
        if ((obj.value & TOOL_GOAL) === 0) {
            // setting a new one
            if (props.lastGoalIndex > -1) {
                // clear last one first:
                props.mapModel.setProperty(props.lastGoalIndex, "value",
                                           props.mapModel.get(props.lastGoalIndex).value &
                                           (~TOOL_GOAL));
            }
            // now memorize the new one:
            props.lastGoalIndex = modelIndex;
        }
    } else
    if (props.currentTool === TOOL_BALL) {
        if ((obj.value & TOOL_BALL) === 0) {
            // setting a new one
            if (props.lastBallIndex > -1)
                // clear last one first:
                props.mapModel.setProperty(props.lastBallIndex, "value",
                                           props.mapModel.get(props.lastBallIndex).value & (~TOOL_BALL));
            // now memorize the new one:
            props.lastBallIndex = modelIndex;
        }
    }

    // special treatment for contacts:
    if (props.currentTool === TOOL_CONTACT) {
        props.mapModel.setProperty(row * map.length + col, "orn", ++props.lastOrderNum);
        props.mapModel.setProperty(row * map.length + col, "contactValue", props.contactValue);
        var newContact =  Number(Number(props.contactValue) + 1).toString()
        props.contactValue = newContact;
    }

    // update value by current tool bit:
    newValue ^= props.currentTool;

    console.log("XXX value=" + obj.value + " typeof=" + typeof(obj.value) + " newValue=" + newValue + " typeof=" + typeof(newValue));
    props.mapModel.setProperty(modelIndex, "value", newValue);
}

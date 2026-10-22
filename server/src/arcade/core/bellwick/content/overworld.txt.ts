/**
 * The overworld: 20 screens on a 5 × 4 grid (bellwick.md §1.4). Row 3 is Kettlebrook village, row 2 the
 * Windmere fields, rows 0–1 Gloamwood. Format: content/parse.ts. Each screen is a header, 9 rows of
 * 12 characters (content/legend.ts) and its directives.
 */
export default String.raw`
@screen 0 oaks 0,0 wood wood
TTTTTTTTTTTT
TTT..TT..TTT
TT..*..*..TT
T.TT....TT.T
T..T....T.,,
T.......*.,,
TT..TT.....T
TT..TT.s..TT
TTTTT,,TTTTT
@stash 8,5 spark 2 flag=stash_oaks
@enemy rootling 6,3
@enemy snapjaw 2,5

@screen 1 logtunnel 1,0 wood wood
TTTTTTTTTTTT
TT.....s..TT
T..HHHHHH..T
T..,,,,,,..T
,,.HHHHHH..T
,,........"T
T.*..,,...*T
T..".,,..""T
TTTTT,,TTTTT
@enemy bat 9,1
@enemy snapjaw 4,3

@screen 2 shore 2,0 wood wood
~~~~~~~~~~~~
~~~%%%%%%~~~
~~~%%%D%%~~~
~~--,,,,,--~
~~-.,,"".--~
T~-..,,*..-T
TT..*.,,,.ST
TT.....,,..T
TTTTTTTT,,TT
@warp 6,2 entry 5,7
@sign 10,6 sign_shore
@enemy bat 9,5
@enemy slingkin 3,6

@screen 3 shrine 3,0 wood wood
TTTTTTTTTTTT
TT..%%%%..TT
T..~%%+%~..T
T.~~~C.~~~.T
T.~~~~~~~~,,
T..~~~~~~.,,
T..~..,..".T
T.."..+...fT
TTTTT,,TTTTT
@chest 5,3 shard flag=shard_shrine
@enemy wisp 4,5

@screen 4 lookout 4,0 wood wood
TTTTTTTTTTTT
T##########T
T#..C.....#T
T#.....*..#T
,,........#T
,,....."..#T
T#........#T
T####..####T
TTTTTTTTTTTT
@chest 4,2 glints 20 flag=chest_lookout
@enemy slingkin 7,5

@screen 5 woodsedge 0,1 wood wood
TTTTT,,TTTTT
TT^^.,,..TTT
T^^..,,.^^.T
T.^..",,.^.T
T....",,,,,,
T.s..,,,,,,,
T^^..,,..^^T
TT^..,,..^TT
TTTTT,,TTTTT
@enemy snapjaw 8,4
@enemy rootling 3,5

@screen 6 mossy 1,1 wood wood
TTTTT,,TTTTT
T^...,,..s.T
T.L..,,....T
T.s..,,..^.T
,,,,,,,,,..T
,,,,,,,,,,,,
T.^..,,,,,,,
T..s.,,..^.T
TTTTT,,TTTTT
@lantern 2,2 mossy
@enemy rootling 8,2
@enemy burrlet 3,6

@screen 7 gate 2,1 wood wood
TTTTTTTT,,TT
TTTTT##,,,TT
TTTTT,,,,TTT
TT^TT,,TTTTT
T^.TT,,TT^^T
,,,,,,,,,,,,
,,,,,,,,,,,,
TS...##..*.T
TT,,TTTTTTTT
@enemy sentinel 5,1 d
@enemy sentinel 6,1 d
@enemy burrlet 9,6
@sign 1,7 sign_gate

@screen 8 ring 3,1 wood wood
TTTTT,,TTTTT
T...#,,#...T
T.#.......#T
T#..~~~~..#T
T#..~~~~..#T
,,..#..#...T
,,.........T
T.."..,,.".T
TTTTT,,TTTTT
@enemy wisp 5,3
@enemy wisp 6,4

@screen 9 glade 4,1 wood wood
TTTTTTTTTTTT
T.RRR..f..*T
T.HHH......T
T....&.....T
T.f.....f..T
T"..*..*.."T
T..........T
T....,,...fT
TTTTT,,TTTTT
@npc 5,3 fennick fennick gift=shard flag=gift_fennick

@screen 10 windmill 0,2 fields village
TTTT^,,TTTTT
T....,,.RRRT
T.*..,,.HHHT
T..C.,,..*.T
T....,,,,,,,
T..vvvv,,,,,
T.*....,..*T
T..""..,"".T
TTTTT,,TTTTT
@chest 3,3 glints 10 flag=chest_windmill
@enemy burrlet 9,6
@enemy burrlet 2,4

@screen 11 crossroads 1,2 fields village
TTTTT,,TTTTT
T*...,,..""T
T..",,,....T
T....,,.S..T
,,,,,,,,,,,,
,,,,,,,,,,,,
T..*.,,..*.T
T"...,,..".T
TTTTT,,TTTTT
@sign 8,3 sign_crossroads
@enemy snapjaw 2,4
@enemy burrlet 8,7

@screen 12 meadow 2,2 fields village
TT,,TTTTTTTT
T.,,.""..""T
T",,.*..*""T
Tv,,vvvvvvvT
,,,,,,,,,,,,
,,,,,,,,,,,,
T.""...""..T
T.f"....".*T
TTTTT,,TTTTT
@enemy burrlet 2,6
@enemy burrlet 9,1

@screen 13 rocky 3,2 fields village
#####,,#####
#....,,.###T
#.#..,,.#Q#T
#....,,....T
,,,,,,,,,..T
,,,,,,,,,,,,
#.#...#.,,,,
#.."..,..#.T
#####,,#####
@warp 9,2 cave 5,7
@enemy slingkin 2,1
@enemy burrlet 10,7

@screen 14 bridge 4,2 fields village
TTTTT,,TTTTT
T*..+,,..*.T
T....,,....T
OO=OOOOOOOOO
OOOOOOOOO=OO
,,,,,,,,,..T
,,,,,,,+,..T
T.*.""..."fT
TTTTT,,TTTTT
@enemy wisp 6,3

@screen 15 millpond 0,3 village village
TTTTT,,TTTTT
T.f..,,..R.T
T.~~~~~~~H.T
T.~~~+~~~~.T
T.~~~.C~~-,,
T.~~~~~~~-,,
T..~~~~~~..T
T"...,....fT
TTTTT+TTTTTT
@chest 6,4 shard flag=shard_millpond
@enemy wisp 7,3

@screen 16 westlane 1,3 village village
TTTTT,,TTTTT
TRRR.,,.RRRT
THHH.,,.HHHT
T.f..,,..f.T
,,,,,,,,,,,,
,,,,,,,,,,,,
T.*..""..*.T
T..||||||..T
TTTTTTTTTTTT
@enemy burrlet 3,6

@screen 17 square 2,3 village village
TTTTT,,TTTTT
TRRRT,,TRRRT
THDHT,,THDHT
T.,..,,..,.T
,,,,,,,,,,,,
,,,,,,,,,,,,
T.f.*.L.*S.T
T"".f...f""T
TTTTTTTTTTTT
@warp 2,2 hesper 5,7
@warp 9,2 shop 5,7
@lantern 6,6 village
@sign 9,6 sign_square
@start 5,4

@screen 18 eastlane 3,3 village village
TTTTT,,TTTTT
T.RRR,,....T
T.HHH,,.|..T
T....,,.|f.T
,,,,,,,,,,,,
,,,,,,,,,,,,
T.*.||||..*T
T.."....""fT
TTTTTTTTTTTT
@enemy burrlet 10,3

@screen 19 orchard 4,3 village village
TTTTT,,TTTTT
T.T.T..T.T.T
T..f.......T
T.T.T..T.T.T
,,.....||..T
,,..|||..||T
T.....B.B.CT
T...||...||T
TTTTTTTTTTTT
@chest 10,6 shard flag=shard_orchard
@enemy burrlet 2,2
@enemy burrlet 9,2
`;

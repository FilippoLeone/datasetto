/** The three interiors: Hesper's house, Pell's Sundries and the Rocky Rise cave (format: content/parse.ts). */
export default String.raw`
@screen 20 hesper - home village
HHHHHHHHHHHH
H;;;;;;;;;;H
H;&;;;;;;C;H
H;;;;;;;;;;H
H;|;;;;;;|;H
H;;;;;;;;;;H
H;;;;;;;;;;H
H;;;;;;;;;;H
HHHHH;;HHHHH
@npc 2,2 hesper hesper gift=glints n=5 flag=gift_hesper
@chest 9,2 sword flag=chest_sword
@exit s square 2,3

@screen 21 shop - home village
HHHHHHHHHHHH
H;;;;&;;;;;H
H[[[[[[[[[[H
H;;;;;;;;;;H
H;;;;;;;;;;H
H;|;;;;;;|;H
H;;;;;;;;;;H
H;;;;;;;;;;H
HHHHH;;HHHHH
@npc 5,1 pell pell
@shop 3,2 buckler 30
@shop 5,2 brew 20
@shop 7,2 shard 80 flag=shop_shard
@talk pell
@exit s square 9,3

@screen 22 cave - cave wood
############
#C::##:::XC#
#:::##::####
#::B::::::##
#:_::::B:_:#
#::::::::::#
#::::::::::#
##::::::::##
#####::#####
@chest 1,1 glints 20 flag=chest_cave
@chest 10,1 shard flag=shard_cave
@shutter flag=cave_shutter
@enemy bat 10,6
@exit s rocky 9,3
`;
